package experiment

import (
	"context"
	"fmt"
	"strconv"

	log "github.com/sirupsen/logrus"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"

	"github.com/determined-ai/determined/master/internal/authz"
	"github.com/determined-ai/determined/master/internal/db"
	"github.com/determined-ai/determined/master/internal/rbac"
	"github.com/determined-ai/determined/master/internal/rbac/audit"
	"github.com/determined-ai/determined/master/internal/usergroup"
	"github.com/determined-ai/determined/master/pkg/model"
	"github.com/determined-ai/determined/proto/pkg/projectv1"
	"github.com/determined-ai/determined/proto/pkg/rbacv1"
)

// ExperimentAuthZRBAC is RBAC enabled controls.
type ExperimentAuthZRBAC struct{}

// permissionMatch represents workspace IDs and whether all permissions matched.
type permissionMatch struct {
	ID        *int
	Permitted bool
}

// GetWorkspaceFromExperiment gets the workspace id given an experiment id.
func GetWorkspaceFromExperiment(ctx context.Context, e *model.Experiment,
) (int32, error) {
	var workspaceID int32
	var q interface{}
	q = db.Bun().NewSelect().Table("experiments").Column("project_id").Where("id = ?", e.ID)
	if e.ProjectID > 0 {
		q = e.ProjectID
	}
	err := db.Bun().NewSelect().Table("projects").Column("workspace_id").Where("id = (?)",
		q).Scan(ctx, &workspaceID)
	return workspaceID, err
}

func getWorkspaceFromProject(ctx context.Context, p *projectv1.Project,
) (int32, error) {
	var workspaceID int32
	err := db.Bun().NewRaw("SELECT workspace_id FROM projects WHERE id = ?",
		p.Id).Scan(ctx, &workspaceID)
	return workspaceID, err
}

func addExpInfo(
	curUser model.User,
	e *model.Experiment,
	logFields log.Fields,
	permission rbacv1.PermissionType,
) {
	logFields["userID"] = curUser.ID
	logFields["username"] = curUser.Username
	logFields["permissionsRequired"] = []audit.PermissionWithSubject{
		{
			PermissionTypes: []rbacv1.PermissionType{permission},
			SubjectType:     "experiment",
			SubjectIDs:      []string{strconv.Itoa(e.ID)},
		},
	}
}

// CanGetExperiment checks if a user has permission to view an experiment.
func (a *ExperimentAuthZRBAC) CanGetExperiment(
	ctx context.Context, curUser model.User, e *model.Experiment,
) (err error) {
	fields := audit.ExtractLogFields(ctx)
	addExpInfo(curUser, e, fields, rbacv1.PermissionType_PERMISSION_TYPE_VIEW_EXPERIMENT_METADATA)
	defer func() {
		if err == nil || authz.IsPermissionDenied(err) {
			fields["permissionGranted"] = !authz.IsPermissionDenied(err)
			audit.Log(fields)
		}
	}()

	workspaceID, err := GetWorkspaceFromExperiment(ctx, e)
	if err != nil {
		return err
	}

	return db.DoesPermissionMatch(ctx, curUser.ID, &workspaceID,
		rbacv1.PermissionType_PERMISSION_TYPE_VIEW_EXPERIMENT_METADATA)
}

// CanGetExperimentArtifacts checks if a user has permission to view experiment artifacts.
func (a *ExperimentAuthZRBAC) CanGetExperimentArtifacts(
	ctx context.Context, curUser model.User, e *model.Experiment,
) (err error) {
	fields := audit.ExtractLogFields(ctx)
	addExpInfo(curUser, e, fields, rbacv1.PermissionType_PERMISSION_TYPE_VIEW_EXPERIMENT_ARTIFACTS)
	defer func() {
		audit.LogFromErr(fields, err)
	}()

	workspaceID, err := GetWorkspaceFromExperiment(ctx, e)
	if err != nil {
		return err
	}

	return db.DoesPermissionMatch(ctx, curUser.ID, &workspaceID,
		rbacv1.PermissionType_PERMISSION_TYPE_VIEW_EXPERIMENT_ARTIFACTS)
}

// CanDeleteExperiment checks if a user has permission to delete an experiment.
func (a *ExperimentAuthZRBAC) CanDeleteExperiment(
	ctx context.Context, curUser model.User, e *model.Experiment,
) (err error) {
	fields := audit.ExtractLogFields(ctx)
	addExpInfo(curUser, e, fields, rbacv1.PermissionType_PERMISSION_TYPE_DELETE_EXPERIMENT)
	defer func() {
		audit.LogFromErr(fields, err)
	}()

	workspaceID, err := GetWorkspaceFromExperiment(ctx, e)
	if err != nil {
		return err
	}

	return db.DoesPermissionMatch(ctx, curUser.ID, &workspaceID,
		rbacv1.PermissionType_PERMISSION_TYPE_DELETE_EXPERIMENT)
}

// FilterExperimentsQuery filters a query for what experiments a user can view.
func (a *ExperimentAuthZRBAC) FilterExperimentsQuery(
	ctx context.Context, curUser model.User, proj *projectv1.Project, query *bun.SelectQuery,
	permissions []rbacv1.PermissionType,
) (selectQuery *bun.SelectQuery, err error) {
	fields := audit.ExtractLogFields(ctx)
	fields["userID"] = curUser.ID
	fields["permissionRequired"] = []audit.PermissionWithSubject{
		{
			PermissionTypes: permissions,
			SubjectType:     "experiments",
		},
	}

	defer func() {
		audit.LogFromErr(fields, nil)
	}()

	groups, _, _, err := usergroup.SearchGroups(ctx, "", curUser.ID, 0, 0)
	if err != nil {
		return nil, fmt.Errorf(
			"error getting users %d groups for filtering experiments: %w", curUser.ID, err)
	}
	if len(groups) == 0 {
		return nil, fmt.Errorf("user %d has to be in at least one group", curUser.ID)
	}
	groupIDs := make([]int, len(groups))
	for i := range groups {
		groupIDs[i] = groups[i].ID
	}

	var workspacePermissions []permissionMatch
	err = db.Bun().NewSelect().
		ColumnExpr("scope_workspace_id AS id").
		ColumnExpr("ARRAY_AGG(permission_assignments.permission_id) @> ? AS permitted",
			pgdialect.Array(permissions)).
		ModelTableExpr("groups").
		Model(&workspacePermissions).
		Join("JOIN role_assignments ON group_id = groups.id").
		Join("JOIN role_assignment_scopes ON role_assignment_scopes.id = role_assignments.scope_id").
		Join("JOIN permission_assignments ON permission_assignments.role_id = role_assignments.role_id").
		Where("groups.id IN (?)", bun.In(groupIDs)).
		Group("scope_workspace_id").
		Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("error getting workspace permissions for filtering experiments: %w", err)
	}

	localPermissionWorkspaces := []int{-1}
	for _, perm := range workspacePermissions {
		if perm.Permitted {
			if perm.ID == nil {
				// global permission
				return query, nil
			}
			localPermissionWorkspaces = append(localPermissionWorkspaces, *perm.ID)
		}
	}

	query = query.Where("workspace_id IN (?)", bun.In(localPermissionWorkspaces))

	return query, nil
}

// FilterExperimentLabelsQuery filters a query for what experiment metadata a user can view.
func (a *ExperimentAuthZRBAC) FilterExperimentLabelsQuery(
	ctx context.Context, curUser model.User, proj *projectv1.Project, query *bun.SelectQuery,
) (selectQuery *bun.SelectQuery, err error) {
	fields := audit.ExtractLogFields(ctx)
	fields["userID"] = curUser.ID
	fields["permissionRequired"] = []audit.PermissionWithSubject{
		{
			PermissionTypes: []rbacv1.PermissionType{
				rbacv1.PermissionType_PERMISSION_TYPE_VIEW_EXPERIMENT_METADATA,
			},
			SubjectType: "experiment",
		},
	}

	defer func() {
		audit.LogFromErr(fields, err)
	}()

	if proj != nil {
		// if proj is not nil, there is already a filter in place
		return query, nil
	}

	assignmentsMap, err := rbac.GetPermissionSummary(ctx, curUser.ID)
	if err != nil {
		return query, err
	}

	var workspaces []int32

	for role, roleAssignments := range assignmentsMap {
		for _, permission := range role.Permissions {
			if permission.ID == int(
				rbacv1.PermissionType_PERMISSION_TYPE_VIEW_EXPERIMENT_METADATA) {
				for _, assignment := range roleAssignments {
					if !assignment.Scope.WorkspaceID.Valid {
						// if permission is global, return without filtering
						return query, nil
					}
					workspaces = append(workspaces, assignment.Scope.WorkspaceID.Int32)
				}
			}
		}
	}

	if len(workspaces) == 0 {
		return query.Where("project_id = -1"), nil
	}

	var projectIDs []int32
	err = db.Bun().NewRaw("SELECT id FROM projects WHERE workspace_id IN (?)",
		bun.In(workspaces)).Scan(ctx, &projectIDs)
	if err != nil {
		return query, err
	}

	query = query.Where("project_id IN (?)", bun.In(projectIDs))

	return query, nil
}

// CanPreviewHPSearch always returns a nil error.
func (a *ExperimentAuthZRBAC) CanPreviewHPSearch(ctx context.Context, curUser model.User,
) (err error) {
	// TODO: does this require any specific permission if you already have the config?
	// Maybe permission to submit the experiment?
	fields := audit.ExtractLogFields(ctx)
	fields["userID"] = curUser.ID
	fields["permissionsRequired"] = []audit.PermissionWithSubject{
		{
			PermissionTypes: []rbacv1.PermissionType{},
			SubjectType:     "preview HP Search",
		},
	}

	defer func() {
		audit.LogFromErr(fields, err)
	}()

	return nil
}

// CanEditExperiment checks if a user can edit an experiment.
func (a *ExperimentAuthZRBAC) CanEditExperiment(
	ctx context.Context, curUser model.User, e *model.Experiment,
) (err error) {
	fields := audit.ExtractLogFields(ctx)
	addExpInfo(curUser, e, fields, rbacv1.PermissionType_PERMISSION_TYPE_UPDATE_EXPERIMENT)
	defer func() {
		audit.LogFromErr(fields, err)
	}()

	workspaceID, err := GetWorkspaceFromExperiment(ctx, e)
	if err != nil {
		return err
	}

	return db.DoesPermissionMatch(ctx, curUser.ID, &workspaceID,
		rbacv1.PermissionType_PERMISSION_TYPE_UPDATE_EXPERIMENT)
}

// CanEditExperimentsMetadata checks if a user can edit an experiment's metadata.
func (a *ExperimentAuthZRBAC) CanEditExperimentsMetadata(
	ctx context.Context, curUser model.User, e *model.Experiment,
) (err error) {
	fields := audit.ExtractLogFields(ctx)
	addExpInfo(curUser, e, fields, rbacv1.PermissionType_PERMISSION_TYPE_UPDATE_EXPERIMENT_METADATA)
	defer func() {
		audit.LogFromErr(fields, err)
	}()

	workspaceID, err := GetWorkspaceFromExperiment(ctx, e)
	if err != nil {
		return err
	}

	return db.DoesPermissionMatch(ctx, curUser.ID, &workspaceID,
		rbacv1.PermissionType_PERMISSION_TYPE_UPDATE_EXPERIMENT_METADATA)
}

// CanCreateExperiment checks if a user can create an experiment.
func (a *ExperimentAuthZRBAC) CanCreateExperiment(
	ctx context.Context, curUser model.User, proj *projectv1.Project,
) (err error) {
	fields := audit.ExtractLogFields(ctx)
	defer func() {
		audit.LogFromErr(fields, err)
	}()

	workspaceID, err := getWorkspaceFromProject(ctx, proj)
	if err != nil {
		return err
	}

	return db.DoesPermissionMatch(ctx, curUser.ID, &workspaceID,
		rbacv1.PermissionType_PERMISSION_TYPE_CREATE_EXPERIMENT)
}

// CanForkFromExperiment checks if a user can create an experiment.
func (a *ExperimentAuthZRBAC) CanForkFromExperiment(
	ctx context.Context, curUser model.User, e *model.Experiment,
) (err error) {
	fields := audit.ExtractLogFields(ctx)
	addExpInfo(curUser, e, fields, rbacv1.PermissionType_PERMISSION_TYPE_VIEW_EXPERIMENT_METADATA)
	defer func() {
		audit.LogFromErr(fields, err)
	}()

	workspaceID, err := GetWorkspaceFromExperiment(ctx, e)
	if err != nil {
		return err
	}

	return db.DoesPermissionMatch(ctx, curUser.ID, &workspaceID,
		rbacv1.PermissionType_PERMISSION_TYPE_VIEW_EXPERIMENT_METADATA)
}

// CanSetExperimentsMaxSlots checks if a user can update an experiment's max slots.
func (a *ExperimentAuthZRBAC) CanSetExperimentsMaxSlots(
	ctx context.Context, curUser model.User, e *model.Experiment, slots int,
) error {
	return a.CanEditExperiment(ctx, curUser, e)
}

// CanSetExperimentsWeight checks if a user can update an experiment's weight.
func (a *ExperimentAuthZRBAC) CanSetExperimentsWeight(
	ctx context.Context, curUser model.User, e *model.Experiment, weight float64,
) error {
	return a.CanEditExperiment(ctx, curUser, e)
}

// CanSetExperimentsPriority checks if a user can update an experiment's priority.
func (a *ExperimentAuthZRBAC) CanSetExperimentsPriority(
	ctx context.Context, curUser model.User, e *model.Experiment, priority int,
) error {
	return a.CanEditExperiment(ctx, curUser, e)
}

// CanSetExperimentsCheckpointGCPolicy checks if a user can update the checkpoint gc policy.
func (a *ExperimentAuthZRBAC) CanSetExperimentsCheckpointGCPolicy(
	ctx context.Context, curUser model.User, e *model.Experiment,
) error {
	return a.CanEditExperiment(ctx, curUser, e)
}

func init() {
	AuthZProvider.Register("rbac", &ExperimentAuthZRBAC{})
}
