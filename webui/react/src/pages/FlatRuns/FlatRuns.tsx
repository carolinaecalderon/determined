import { CompactSelection, GridSelection } from '@glideapps/glide-data-grid';
import { isLeft } from 'fp-ts/lib/Either';
import Button from 'hew/Button';
import Column from 'hew/Column';
import {
  ColumnDef,
  DEFAULT_COLUMN_WIDTH,
  defaultDateColumn,
  defaultNumberColumn,
  defaultSelectionColumn,
  defaultTextColumn,
  MIN_COLUMN_WIDTH,
  MULTISELECT,
} from 'hew/DataGrid/columns';
import { ContextMenuCompleteHandlerProps } from 'hew/DataGrid/contextMenu';
import DataGrid, {
  DataGridHandle,
  HandleSelectionChangeType,
  RangelessSelectionType,
  SelectionType,
  Sort,
  validSort,
  ValidSort,
} from 'hew/DataGrid/DataGrid';
import { MenuItem } from 'hew/Dropdown';
import Icon from 'hew/Icon';
import Link from 'hew/Link';
import Message from 'hew/Message';
import Pagination from 'hew/Pagination';
import Row from 'hew/Row';
import { Loadable, Loaded, NotLoaded } from 'hew/utils/loadable';
import { useObservable } from 'micro-observables';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import ColumnPickerMenu from 'components/ColumnPickerMenu';
import ComparisonView from 'components/ComparisonView';
import { Error } from 'components/exceptions';
import { FilterFormStore, ROOT_ID } from 'components/FilterForm/components/FilterFormStore';
import {
  AvailableOperators,
  FormKind,
  IOFilterFormSet,
  Operator,
  SpecialColumnNames,
} from 'components/FilterForm/components/type';
import TableFilter from 'components/FilterForm/TableFilter';
import MultiSortMenu, { EMPTY_SORT, sortMenuItemsForColumn } from 'components/MultiSortMenu';
import { OptionsMenu, RowHeight } from 'components/OptionsMenu';
import {
  DataGridGlobalSettings,
  rowHeightMap,
  settingsConfigGlobal,
} from 'components/OptionsMenu.settings';
import useUI from 'components/ThemeProvider';
import { useAsync } from 'hooks/useAsync';
import { useGlasbey } from 'hooks/useGlasbey';
import useMobile from 'hooks/useMobile';
import usePolling from 'hooks/usePolling';
import useResize from 'hooks/useResize';
import useScrollbarWidth from 'hooks/useScrollbarWidth';
import { useSettings } from 'hooks/useSettings';
import useTypedParams from 'hooks/useTypedParams';
import {
  DEFAULT_SELECTION,
  SelectionType as SelectionState,
} from 'pages/F_ExpList/F_ExperimentList.settings';
import { paths } from 'routes/utils';
import { getProjectColumns, getProjectNumericMetricsRange, searchRuns } from 'services/api';
import { V1ColumnType, V1LocationType } from 'services/api-ts-sdk';
import userStore from 'stores/users';
import userSettings from 'stores/userSettings';
import { DetailedUser, ExperimentAction, FlatRun, ProjectColumn } from 'types';
import handleError from 'utils/error';
import { eagerSubscribe } from 'utils/observable';
import { pluralizer } from 'utils/string';

import {
  defaultColumnWidths,
  defaultRunColumns,
  defaultSearchRunColumns,
  getColumnDefs,
  RunColumn,
  runColumns,
  searcherMetricsValColumn,
} from './columns';
import css from './FlatRuns.module.scss';
import {
  defaultFlatRunsSettings,
  FlatRunsSettings,
  ProjectUrlSettings,
  settingsPathForProject,
} from './FlatRuns.settings';

export const PAGE_SIZE = 100;
const INITIAL_LOADING_RUNS: Loadable<FlatRun>[] = new Array(PAGE_SIZE).fill(NotLoaded);

const STATIC_COLUMNS = [MULTISELECT];

const BANNED_FILTER_COLUMNS = new Set(['searcherMetricsVal']);

const NO_PINS_WIDTH = 200;

const formStore = new FilterFormStore();

interface Props {
  projectId: number;
  searchId?: number;
}

const makeSortString = (sorts: ValidSort[]): string =>
  sorts.map((s) => `${s.column}=${s.direction}`).join(',');

const parseSortString = (sortString: string): Sort[] => {
  if (!sortString) return [EMPTY_SORT];
  const components = sortString.split(',');
  return components.map((c) => {
    const [column, direction] = c.split('=', 2);
    return {
      column,
      direction: direction === 'asc' || direction === 'desc' ? direction : undefined,
    };
  });
};

const FlatRuns: React.FC<Props> = ({ projectId, searchId }) => {
  const dataGridRef = useRef<DataGridHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { params, updateParams } = useTypedParams(ProjectUrlSettings, {});
  const page = params.page || 0;
  const setPage = useCallback(
    (p: number) => updateParams({ page: p || undefined }),
    [updateParams],
  );

  const settingsPath = useMemo(
    () => settingsPathForProject(projectId, searchId),
    [projectId, searchId],
  );
  const flatRunsSettingsObs = useMemo(
    () => userSettings.get(FlatRunsSettings, settingsPath),
    [settingsPath],
  );
  const flatRunsSettings = useObservable(flatRunsSettingsObs);
  const isLoadingSettings = useMemo(() => flatRunsSettings.isNotLoaded, [flatRunsSettings]);
  const updateSettings = useCallback(
    (p: Partial<FlatRunsSettings>) => userSettings.setPartial(FlatRunsSettings, settingsPath, p),
    [settingsPath],
  );
  const settings = useMemo(() => {
    const defaultSettings = { ...defaultFlatRunsSettings };
    if (searchId) {
      defaultSettings.columns = defaultSearchRunColumns;
    }
    return flatRunsSettings.map((s) => ({ ...defaultSettings, ...s })).getOrElse(defaultSettings);
  }, [flatRunsSettings, searchId]);

  const { settings: globalSettings, updateSettings: updateGlobalSettings } =
    useSettings<DataGridGlobalSettings>(settingsConfigGlobal);

  const [isOpenFilter, setIsOpenFilter] = useState<boolean>(false);
  const [runs, setRuns] = useState<Loadable<FlatRun>[]>(INITIAL_LOADING_RUNS);
  const isPagedView = true;

  const [sorts, setSorts] = useState<Sort[]>(() => {
    if (!isLoadingSettings) {
      return parseSortString(settings.sortString);
    }
    return [EMPTY_SORT];
  });
  const sortString = useMemo(() => makeSortString(sorts.filter(validSort.is)), [sorts]);
  const loadableFormset = useObservable(formStore.formset);
  const filtersString = useObservable(formStore.asJsonString);
  const [total, setTotal] = useState<Loadable<number>>(NotLoaded);
  const isMobile = useMobile();
  const [isLoading, setIsLoading] = useState(true);
  const [error] = useState(false);
  const [canceler] = useState(new AbortController());
  const users = useObservable<Loadable<DetailedUser[]>>(userStore.getUsers());

  const { width: containerWidth } = useResize(contentRef);

  const {
    ui: { theme: appTheme },
    isDarkMode,
  } = useUI();

  const projectHeatmap = useAsync(async () => {
    try {
      return await getProjectNumericMetricsRange({ id: projectId });
    } catch (e) {
      handleError(e, { publicSubject: 'Unable to fetch project heatmap' });
      return NotLoaded;
    }
  }, [projectId]);

  const projectColumns = useAsync(async () => {
    try {
      const columns = await getProjectColumns({ id: projectId });
      columns.sort((a, b) =>
        a.location === V1LocationType.EXPERIMENT && b.location === V1LocationType.EXPERIMENT
          ? runColumns.indexOf(a.column as RunColumn) - runColumns.indexOf(b.column as RunColumn)
          : 0,
      );
      return columns;
    } catch (e) {
      handleError(e, { publicSubject: 'Unable to fetch project columns' });
      return NotLoaded;
    }
  }, [projectId]);

  const columnsIfLoaded = useMemo(
    () => (isLoadingSettings ? [] : settings.columns),
    [isLoadingSettings, settings.columns],
  );

  const showPagination = useMemo(() => {
    return (
      isPagedView &&
      (!settings.compare || settings.pinnedColumnsCount !== 0) &&
      !(isMobile && settings.compare)
    );
  }, [isMobile, isPagedView, settings.compare, settings.pinnedColumnsCount]);

  const [loadedSelectedRuns, loadedSelectedRunIds] = useMemo(() => {
    const selectedMap = new Map<number, { run: FlatRun; index: number }>();
    const selectedArray: FlatRun[] = [];
    if (isLoadingSettings) {
      return [selectedArray, selectedMap];
    }
    const selectedIdSet = new Set(
      settings.selection.type === 'ONLY_IN' ? settings.selection.selections : [],
    );
    runs.forEach((r, index) => {
      Loadable.forEach(r, (run) => {
        if (selectedIdSet.has(run.id)) {
          selectedMap.set(run.id, { index, run });
          selectedArray.push(run);
        }
      });
    });
    return [selectedArray, selectedMap];
  }, [isLoadingSettings, settings.selection, runs]);

  const selection = useMemo<GridSelection>(() => {
    let rows = CompactSelection.empty();
    loadedSelectedRunIds.forEach((info) => {
      rows = rows.add(info.index);
    });
    return {
      columns: CompactSelection.empty(),
      rows,
    };
  }, [loadedSelectedRunIds]);

  const handleIsOpenFilterChange = useCallback((newOpen: boolean) => {
    setIsOpenFilter(newOpen);
    if (!newOpen) {
      formStore.sweep();
    }
  }, []);

  const colorMap = useGlasbey([...loadedSelectedRunIds.keys()]);

  const handleToggleComparisonView = useCallback(() => {
    updateSettings({ compare: !settings.compare });
  }, [settings.compare, updateSettings]);

  const pinnedColumns = useMemo(() => {
    return [...STATIC_COLUMNS, ...settings.columns.slice(0, settings.pinnedColumnsCount)];
  }, [settings.columns, settings.pinnedColumnsCount]);

  const columns: ColumnDef<FlatRun>[] = useMemo(() => {
    const projectColumnsMap: Loadable<Record<string, ProjectColumn>> = Loadable.map(
      projectColumns,
      (columns) => {
        return columns.reduce((acc, col) => ({ ...acc, [col.column]: col }), {});
      },
    );
    const columnDefs = getColumnDefs({
      appTheme,
      columnWidths: settings.columnWidths,
      themeIsDark: isDarkMode,
      users,
    });
    const gridColumns = (
      settings.compare
        ? [...STATIC_COLUMNS, ...columnsIfLoaded.slice(0, settings.pinnedColumnsCount)]
        : [...STATIC_COLUMNS, ...columnsIfLoaded]
    )
      .map((columnName) => {
        if (columnName === MULTISELECT) {
          return defaultSelectionColumn(selection.rows, false);
        }

        if (columnName in columnDefs) return columnDefs[columnName];
        const currentColumn = projectColumnsMap.getOrElse({})[columnName];
        if (!currentColumn) return;
        let dataPath: string | undefined = undefined;

        switch (currentColumn.location) {
          case V1LocationType.EXPERIMENT:
            dataPath = `experiment.${currentColumn.column}`;
            break;
          case V1LocationType.RUN:
            dataPath = currentColumn.column;
            break;
          case V1LocationType.HYPERPARAMETERS:
          case V1LocationType.RUNHYPERPARAMETERS:
            dataPath = `hyperparameters.${currentColumn.column.replace('hp.', '')}.val`;
            break;
          case V1LocationType.VALIDATIONS:
            dataPath = `summaryMetrics.validationMetrics.${currentColumn.column.replace(
              'validation.',
              '',
            )}`;
            break;
          case V1LocationType.TRAINING:
            dataPath = `summaryMetrics.avgMetrics.${currentColumn.column.replace('training.', '')}`;
            break;
          case V1LocationType.CUSTOMMETRIC:
            dataPath = `summaryMetrics.${currentColumn.column}`;
            break;
          case V1LocationType.UNSPECIFIED:
          default:
            break;
        }
        switch (currentColumn.type) {
          case V1ColumnType.NUMBER: {
            const heatmap = projectHeatmap
              .getOrElse([])
              .find((h) => h.metricsName === currentColumn.column);
            if (
              heatmap &&
              settings.heatmapOn &&
              !settings.heatmapSkipped.includes(currentColumn.column)
            ) {
              columnDefs[currentColumn.column] = defaultNumberColumn(
                currentColumn.column,
                currentColumn.displayName || currentColumn.column,
                settings.columnWidths[currentColumn.column] ??
                  defaultColumnWidths[currentColumn.column as RunColumn] ??
                  MIN_COLUMN_WIDTH,
                dataPath,
                {
                  max: heatmap.max,
                  min: heatmap.min,
                },
              );
            } else {
              columnDefs[currentColumn.column] = defaultNumberColumn(
                currentColumn.column,
                currentColumn.displayName || currentColumn.column,
                settings.columnWidths[currentColumn.column] ??
                  defaultColumnWidths[currentColumn.column as RunColumn] ??
                  MIN_COLUMN_WIDTH,
                dataPath,
              );
            }
            break;
          }
          case V1ColumnType.DATE:
            columnDefs[currentColumn.column] = defaultDateColumn(
              currentColumn.column,
              currentColumn.displayName || currentColumn.column,
              settings.columnWidths[currentColumn.column] ??
                defaultColumnWidths[currentColumn.column as RunColumn] ??
                MIN_COLUMN_WIDTH,
              dataPath,
            );
            break;
          case V1ColumnType.TEXT:
          case V1ColumnType.UNSPECIFIED:
          default:
            columnDefs[currentColumn.column] = defaultTextColumn(
              currentColumn.column,
              currentColumn.displayName || currentColumn.column,
              settings.columnWidths[currentColumn.column] ??
                defaultColumnWidths[currentColumn.column as RunColumn] ??
                MIN_COLUMN_WIDTH,
              dataPath,
            );
        }
        if (currentColumn.column === 'searcherMetricsVal') {
          const heatmap = projectHeatmap
            .getOrElse([])
            .find((h) => h.metricsName === currentColumn.column);

          columnDefs[currentColumn.column] = searcherMetricsValColumn(
            settings.columnWidths[currentColumn.column],
            heatmap && settings.heatmapOn && !settings.heatmapSkipped.includes(currentColumn.column)
              ? {
                  max: heatmap.max,
                  min: heatmap.min,
                }
              : undefined,
          );
        }
        return columnDefs[currentColumn.column];
      })
      .flatMap((col) => (col ? [col] : []));
    return gridColumns;
  }, [
    appTheme,
    columnsIfLoaded,
    isDarkMode,
    projectColumns,
    projectHeatmap,
    selection.rows,
    settings.columnWidths,
    settings.compare,
    settings.heatmapOn,
    settings.heatmapSkipped,
    settings.pinnedColumnsCount,
    users,
  ]);

  const onRowHeightChange = useCallback(
    (newRowHeight: RowHeight) => {
      updateGlobalSettings({ rowHeight: newRowHeight });
    },
    [updateGlobalSettings],
  );

  const handleHeatmapToggle = useCallback(
    (heatmapOn: boolean) => updateSettings({ heatmapOn: !heatmapOn }),
    [updateSettings],
  );

  const handleHeatmapSelection = useCallback(
    (selection: string[]) => updateSettings({ heatmapSkipped: selection }),
    [updateSettings],
  );

  const heatmapBtnVisible = useMemo(() => {
    const visibleColumns = settings.columns.slice(
      0,
      settings.compare ? settings.pinnedColumnsCount : undefined,
    );
    return Loadable.getOrElse([], projectColumns).some(
      (column) =>
        visibleColumns.includes(column.column) &&
        (column.column === 'searcherMetricsVal' ||
          (column.type === V1ColumnType.NUMBER &&
            (column.location === V1LocationType.VALIDATIONS ||
              column.location === V1LocationType.TRAINING))),
    );
  }, [settings.columns, projectColumns, settings.pinnedColumnsCount, settings.compare]);

  const onPageChange = useCallback(
    (cPage: number, cPageSize: number) => {
      updateSettings({ pageLimit: cPageSize });
      // Pagination component is assuming starting index of 1.
      if (cPage - 1 !== page) {
        setRuns(Array(cPageSize).fill(NotLoaded));
      }
      setPage(cPage - 1);
    },
    [page, updateSettings, setPage],
  );

  const fetchRuns = useCallback(async (): Promise<void> => {
    if (isLoadingSettings || Loadable.isNotLoaded(loadableFormset)) return;
    try {
      const filters = JSON.parse(filtersString);
      if (searchId) {
        // only display trials for search
        const existingFilterGroup = { ...filters.filterGroup };
        const searchFilter = {
          columnName: 'experimentId',
          kind: 'field',
          location: 'LOCATION_TYPE_RUN',
          operator: '=',
          type: 'COLUMN_TYPE_NUMBER',
          value: searchId,
        };
        filters.filterGroup = {
          children: [existingFilterGroup, searchFilter],
          conjunction: 'and',
          kind: 'group',
        };
      }
      const tableOffset = Math.max((page - 0.5) * PAGE_SIZE, 0);
      const response = await searchRuns(
        {
          filter: JSON.stringify(filters),
          limit: isPagedView ? settings.pageLimit : 2 * PAGE_SIZE,
          offset: isPagedView ? page * settings.pageLimit : tableOffset,
          projectId: projectId,
          sort: sortString || undefined,
        },
        { signal: canceler.signal },
      );
      const loadedRuns = response.runs;

      setRuns((prev) => {
        if (isPagedView) {
          return loadedRuns.map((run) => Loaded(run));
        }

        // Update the list with the fetched results.
        return prev.toSpliced(
          tableOffset,
          loadedRuns.length,
          ...loadedRuns.map((experiment) => Loaded(experiment)),
        );
      });
      setTotal(
        response.pagination.total !== undefined ? Loaded(response.pagination.total) : NotLoaded,
      );
    } catch (e) {
      handleError(e, { publicSubject: 'Unable to fetch runs.' });
    } finally {
      setIsLoading(false);
    }
  }, [
    canceler.signal,
    filtersString,
    isLoadingSettings,
    isPagedView,
    loadableFormset,
    page,
    projectId,
    settings.pageLimit,
    sortString,
    searchId,
  ]);

  const { stopPolling } = usePolling(fetchRuns, { rerunOnNewFn: true });

  const numFilters = 0;

  const resetPagination = useCallback(() => {
    setIsLoading(true);
    setPage(0);
    setRuns(INITIAL_LOADING_RUNS);
  }, [setPage]);

  useEffect(() => {
    if (!isLoadingSettings && settings.sortString) {
      setSorts(parseSortString(settings.sortString));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingSettings]);

  useEffect(() => {
    let cleanup: () => void;
    // eagerSubscribe is like subscribe but it runs once before the observed value changes.
    cleanup = eagerSubscribe(flatRunsSettingsObs, (ps, prevPs) => {
      // init formset once from settings when loaded, then flip the sync
      // direction -- when formset changes, update settings
      if (!prevPs?.isLoaded) {
        ps.forEach((s) => {
          cleanup?.();
          if (!s?.filterset) {
            formStore.init();
          } else {
            const formSetValidation = IOFilterFormSet.decode(JSON.parse(s.filterset));
            if (isLeft(formSetValidation)) {
              handleError(formSetValidation.left, {
                publicSubject: 'Unable to initialize filterset from settings',
              });
            } else {
              formStore.init(formSetValidation.right);
            }
          }
          cleanup = formStore.asJsonString.subscribe(() => {
            resetPagination();
            const loadableFormset = formStore.formset.get();
            Loadable.forEach(loadableFormset, (formSet) =>
              updateSettings({ filterset: JSON.stringify(formSet), selection: DEFAULT_SELECTION }),
            );
          });
        });
      }
    });
    return () => cleanup?.();
  }, [flatRunsSettingsObs, resetPagination, updateSettings]);

  const scrollbarWidth = useScrollbarWidth();

  const comparisonViewTableWidth = useMemo(() => {
    if (pinnedColumns.length === 1) return NO_PINS_WIDTH;
    return Math.min(
      containerWidth - 30,
      pinnedColumns.reduce(
        (totalWidth, curCol) =>
          totalWidth + (settings.columnWidths[curCol] ?? DEFAULT_COLUMN_WIDTH),
        scrollbarWidth,
      ),
    );
  }, [containerWidth, pinnedColumns, scrollbarWidth, settings.columnWidths]);

  const handleCompareWidthChange = useCallback(
    (newTableWidth: number) => {
      const widthDifference = newTableWidth - comparisonViewTableWidth;
      // Positive widthDifference: Table pane growing/compare pane shrinking
      // Negative widthDifference: Table pane shrinking/compare pane growing
      const newColumnWidths: Record<string, number> = {
        ...settings.columnWidths,
      };
      pinnedColumns
        .filter(
          (col) =>
            !STATIC_COLUMNS.includes(col) &&
            (widthDifference > 0 || newColumnWidths[col] > MIN_COLUMN_WIDTH),
        )
        .forEach((col, _, arr) => {
          newColumnWidths[col] = Math.max(
            MIN_COLUMN_WIDTH,
            newColumnWidths[col] + widthDifference / arr.length,
          );
        });
      updateSettings({
        columnWidths: newColumnWidths,
      });
    },
    [updateSettings, settings.columnWidths, pinnedColumns, comparisonViewTableWidth],
  );

  const handleColumnWidthChange = useCallback(
    (columnId: string, width: number) => {
      updateSettings({
        columnWidths: { ...settings.columnWidths, [columnId]: Math.max(MIN_COLUMN_WIDTH, width) },
      });
    },
    [settings.columnWidths, updateSettings],
  );

  const rowRangeToIds = useCallback(
    (range: [number, number]) => {
      const slice = runs.slice(range[0], range[1]);
      return Loadable.filterNotLoaded(slice).map((run) => run.id);
    },
    [runs],
  );

  const handleSelectionChange: HandleSelectionChangeType = useCallback(
    (selectionType: SelectionType | RangelessSelectionType, range?: [number, number]) => {
      let newSettings: SelectionState = { ...settings.selection };

      switch (selectionType) {
        case 'add':
          if (!range) return;
          if (newSettings.type === 'ALL_EXCEPT') {
            const excludedSet = new Set(newSettings.exclusions);
            rowRangeToIds(range).forEach((id) => excludedSet.delete(id));
            newSettings.exclusions = Array.from(excludedSet);
          } else {
            const includedSet = new Set(newSettings.selections);
            rowRangeToIds(range).forEach((id) => includedSet.add(id));
            newSettings.selections = Array.from(includedSet);
          }

          break;
        case 'add-all':
          newSettings = {
            exclusions: [],
            type: 'ALL_EXCEPT' as const,
          };

          break;
        case 'remove':
          if (!range) return;
          if (newSettings.type === 'ALL_EXCEPT') {
            const excludedSet = new Set(newSettings.exclusions);
            rowRangeToIds(range).forEach((id) => excludedSet.add(id));
            newSettings.exclusions = Array.from(excludedSet);
          } else {
            const includedSet = new Set(newSettings.selections);
            rowRangeToIds(range).forEach((id) => includedSet.delete(id));
            newSettings.selections = Array.from(includedSet);
          }

          break;
        case 'remove-all':
          newSettings = DEFAULT_SELECTION;

          break;
        case 'set':
          if (!range) return;
          newSettings = {
            ...DEFAULT_SELECTION,
            selections: Array.from(rowRangeToIds(range)),
          };

          break;
      }

      updateSettings({ selection: newSettings });
    },
    [rowRangeToIds, settings.selection, updateSettings],
  );

  const handleContextMenuComplete: ContextMenuCompleteHandlerProps<ExperimentAction, FlatRun> =
    useCallback(() => {}, []);

  const handleColumnsOrderChange = useCallback(
    // changing both column order and pinned count should happen in one update:
    (newColumnsOrder: string[], pinnedCount?: number) => {
      const newColumnWidths = newColumnsOrder
        .filter((c) => !(c in settings.columnWidths))
        .reduce((acc: Record<string, number>, col) => {
          acc[col] = DEFAULT_COLUMN_WIDTH;
          return acc;
        }, {});
      updateSettings({
        columns: newColumnsOrder,
        columnWidths: {
          ...settings.columnWidths,
          ...newColumnWidths,
        },
        pinnedColumnsCount: pinnedCount ?? settings.pinnedColumnsCount,
      });
    },
    [updateSettings, settings.pinnedColumnsCount, settings.columnWidths],
  );

  const handleSortChange = useCallback(
    (sorts: Sort[]) => {
      setSorts(sorts);
      const newSortString = makeSortString(sorts.filter(validSort.is));
      if (newSortString !== sortString) {
        resetPagination();
      }
      updateSettings({ sortString: newSortString });
    },
    [resetPagination, sortString, updateSettings],
  );

  const getRowAccentColor = (rowData: FlatRun) => {
    return colorMap[rowData.id];
  };

  const handlePinnedColumnsCountChange = useCallback(
    (newCount: number) => updateSettings({ pinnedColumnsCount: newCount }),
    [updateSettings],
  );

  const getHeaderMenuItems = useCallback(
    (columnId: string, colIdx: number): MenuItem[] => {
      if (columnId === MULTISELECT) {
        const items: MenuItem[] = [
          settings.selection.type === 'ALL_EXCEPT' || settings.selection.selections.length > 0
            ? {
                key: 'select-none',
                label: 'Clear selected',
                onClick: () => {
                  handleSelectionChange?.('remove-all');
                },
              }
            : null,
          ...[5, 10, 25].map((n) => ({
            key: `select-${n}`,
            label: `Select first ${n}`,
            onClick: () => {
              handleSelectionChange?.('set', [0, n]);
              dataGridRef.current?.scrollToTop();
            },
          })),
          {
            key: 'select-all',
            label: 'Select all',
            onClick: () => {
              handleSelectionChange?.('set', [0, settings.pageLimit]);
            },
          },
        ];
        return items;
      }

      const column = Loadable.getOrElse([], projectColumns).find((c) => c.column === columnId);
      const isPinned = colIdx <= settings.pinnedColumnsCount + STATIC_COLUMNS.length - 1;
      const items: MenuItem[] = [
        // Column is pinned if the index is inside of the frozen columns
        colIdx < STATIC_COLUMNS.length || isMobile
          ? null
          : !isPinned
            ? {
                icon: <Icon decorative name="pin" />,
                key: 'pin',
                label: 'Pin column',
                onClick: () => {
                  const newColumnsOrder = columnsIfLoaded.filter((c) => c !== columnId);
                  newColumnsOrder.splice(settings.pinnedColumnsCount, 0, columnId);
                  handleColumnsOrderChange(
                    newColumnsOrder,
                    Math.min(settings.pinnedColumnsCount + 1, columnsIfLoaded.length),
                  );
                },
              }
            : {
                disabled: settings.pinnedColumnsCount <= 1,
                icon: <Icon decorative name="pin" />,
                key: 'unpin',
                label: 'Unpin column',
                onClick: () => {
                  const newColumnsOrder = columnsIfLoaded.filter((c) => c !== columnId);
                  newColumnsOrder.splice(settings.pinnedColumnsCount - 1, 0, columnId);
                  handleColumnsOrderChange(
                    newColumnsOrder,
                    Math.max(settings.pinnedColumnsCount - 1, 0),
                  );
                },
              },
        {
          icon: <Icon decorative name="eye-close" />,
          key: 'hide',
          label: 'Hide column',
          onClick: () => {
            const newColumnsOrder = columnsIfLoaded.filter((c) => c !== columnId);
            if (isPinned) {
              handleColumnsOrderChange(
                newColumnsOrder,
                Math.max(settings.pinnedColumnsCount - 1, 0),
              );
            } else {
              handleColumnsOrderChange(newColumnsOrder);
            }
          },
        },
      ];

      if (!column) {
        return items;
      }

      const filterMenuItemsForColumn = () => {
        const isSpecialColumn = (SpecialColumnNames as ReadonlyArray<string>).includes(
          column.column,
        );
        formStore.addChild(ROOT_ID, FormKind.Field, {
          index: Loadable.match(loadableFormset, {
            _: () => 0,
            Loaded: (formset) => formset.filterGroup.children.length,
          }),
          item: {
            columnName: column.column,
            id: uuidv4(),
            kind: FormKind.Field,
            location: column.location,
            operator: isSpecialColumn ? Operator.Eq : AvailableOperators[column.type][0],
            type: column.type,
            value: null,
          },
        });
        handleIsOpenFilterChange?.(true);
      };

      const clearFilterForColumn = () => {
        formStore.removeByField(column.column);
      };

      const filterCount = formStore.getFieldCount(column.column).get();

      if (!BANNED_FILTER_COLUMNS.has(column.column)) {
        const sortCount = sortMenuItemsForColumn(column, sorts, handleSortChange).length;
        const sortMenuItems =
          sortCount === 0
            ? []
            : [
                { type: 'divider' as const },
                ...sortMenuItemsForColumn(column, sorts, handleSortChange),
              ];

        items.push(
          ...sortMenuItems,
          { type: 'divider' as const },
          {
            icon: <Icon decorative name="filter" />,
            key: 'filter',
            label: 'Add Filter',
            onClick: () => {
              setTimeout(filterMenuItemsForColumn, 5);
            },
          },
        );
      }

      if (filterCount > 0) {
        items.push({
          icon: <Icon decorative name="filter" />,
          key: 'filter-clear',
          label: `Clear ${pluralizer(filterCount, 'Filter')}  (${filterCount})`,
          onClick: () => {
            setTimeout(clearFilterForColumn, 5);
          },
        });
      }
      if (
        settings.heatmapOn &&
        (column.column === 'searcherMetricsVal' ||
          (column.type === V1ColumnType.NUMBER &&
            (column.location === V1LocationType.VALIDATIONS ||
              column.location === V1LocationType.TRAINING)))
      ) {
        items.push(
          { type: 'divider' as const },
          {
            icon: <Icon decorative name="heatmap" />,
            key: 'heatmap',
            label: !settings.heatmapSkipped.includes(column.column)
              ? 'Cancel heatmap'
              : 'Apply heatmap',
            onClick: () =>
              handleHeatmapSelection?.(
                settings.heatmapSkipped.includes(column.column)
                  ? settings.heatmapSkipped.filter((p) => p !== column.column)
                  : [...settings.heatmapSkipped, column.column],
              ),
          },
        );
      }
      return items;
    },
    [
      projectColumns,
      settings.pinnedColumnsCount,
      settings.selection,
      settings.pageLimit,
      settings.heatmapOn,
      settings.heatmapSkipped,
      isMobile,
      handleSelectionChange,
      columnsIfLoaded,
      handleColumnsOrderChange,
      loadableFormset,
      handleIsOpenFilterChange,
      sorts,
      handleSortChange,
      handleHeatmapSelection,
    ],
  );

  useEffect(() => {
    return () => {
      canceler.abort();
      stopPolling();
    };
  }, [canceler, stopPolling]);

  return (
    <div className={css.content} ref={contentRef}>
      <Row>
        <Column>
          <Row>
            <TableFilter
              bannedFilterColumns={BANNED_FILTER_COLUMNS}
              formStore={formStore}
              isMobile={isMobile}
              isOpenFilter={isOpenFilter}
              loadableColumns={projectColumns}
              onIsOpenFilterChange={handleIsOpenFilterChange}
            />
            <MultiSortMenu
              columns={projectColumns}
              isMobile={isMobile}
              sorts={sorts}
              onChange={handleSortChange}
            />
            <ColumnPickerMenu
              defaultVisibleColumns={searchId ? defaultSearchRunColumns : defaultRunColumns}
              initialVisibleColumns={columnsIfLoaded}
              isMobile={isMobile}
              pinnedColumnsCount={settings.pinnedColumnsCount}
              projectColumns={projectColumns}
              projectId={projectId}
              tabs={[
                V1LocationType.EXPERIMENT,
                [V1LocationType.VALIDATIONS, V1LocationType.TRAINING, V1LocationType.CUSTOMMETRIC],
                V1LocationType.HYPERPARAMETERS,
              ]}
              onVisibleColumnChange={handleColumnsOrderChange}
            />
            <OptionsMenu
              rowHeight={globalSettings.rowHeight}
              onRowHeightChange={onRowHeightChange}
            />
          </Row>
        </Column>
        <Column align="right">
          <Row>
            {heatmapBtnVisible && (
              <Button
                icon={<Icon name="heatmap" title="heatmap" />}
                tooltip="Toggle Metric Heatmap"
                type={settings.heatmapOn ? 'primary' : 'default'}
                onClick={() => handleHeatmapToggle(settings.heatmapOn ?? false)}
              />
            )}
            <Button
              hideChildren={isMobile}
              icon={<Icon name={settings.compare ? 'panel-on' : 'panel'} title="compare" />}
              onClick={handleToggleComparisonView}>
              Compare
            </Button>
          </Row>
        </Column>
      </Row>
      {!isLoading && total.isLoaded && total.data === 0 ? (
        numFilters === 0 ? (
          <Message
            action={
              <Link external href={paths.docs('/get-started/webui-qs.html')}>
                Quick Start Guide
              </Link>
            }
            description="Keep track of runs in a project by connecting up your code."
            icon="experiment"
            title="No Runs"
          />
        ) : (
          <Message description="No results matching your filters" icon="search" />
        )
      ) : error ? (
        <Error fetchData={fetchRuns} />
      ) : (
        <>
          <ComparisonView
            fixedColumnsCount={STATIC_COLUMNS.length + settings.pinnedColumnsCount}
            initialWidth={comparisonViewTableWidth}
            open={settings.compare}
            projectId={projectId}
            selectedRuns={loadedSelectedRuns}
            onWidthChange={handleCompareWidthChange}>
            <DataGrid
              columns={columns}
              data={runs}
              getHeaderMenuItems={getHeaderMenuItems}
              getRowAccentColor={getRowAccentColor}
              imperativeRef={dataGridRef}
              isPaginated={isPagedView}
              page={page}
              pageSize={PAGE_SIZE}
              pinnedColumnsCount={isLoadingSettings ? 0 : settings.pinnedColumnsCount}
              rowHeight={rowHeightMap[globalSettings.rowHeight as RowHeight]}
              selection={selection}
              sorts={sorts}
              staticColumns={STATIC_COLUMNS}
              total={total.getOrElse(PAGE_SIZE)}
              onColumnResize={handleColumnWidthChange}
              onColumnsOrderChange={handleColumnsOrderChange}
              onContextMenuComplete={handleContextMenuComplete}
              onPageUpdate={setPage}
              onPinnedColumnsCountChange={handlePinnedColumnsCountChange}
              onSelectionChange={handleSelectionChange}
            />
          </ComparisonView>
          {showPagination && (
            <Row>
              <Column align="right">
                <Pagination
                  current={page + 1}
                  pageSize={settings.pageLimit}
                  pageSizeOptions={[20, 40, 80]}
                  total={Loadable.getOrElse(0, total)}
                  onChange={onPageChange}
                />
              </Column>
            </Row>
          )}
        </>
      )}
    </div>
  );
};

export default FlatRuns;
