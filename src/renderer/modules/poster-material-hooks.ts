import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { PosterState } from '../../shared/group-poster.js';
import { hasPosterMaterialContent } from '../../shared/group-poster.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import { api } from '../api.js';
import {
  createEmptyMaterialDraft,
  toMaterialDraft,
  type PosterMaterialMatrixHandle,
} from '../poster-material-matrix.js';
import { errMsg } from './shared/module-ui.js';
import {
  applyBatchMaterialPatch,
  mergeServerMaterialsIntoDrafts,
  toMaterialInputs,
} from './poster-material-modals.js';
export function usePosterMaterials({
  state,
  selectedCardIds,
  busy,
  action,
  onError,
  onState,
  onMessage,
}: {
  state: PosterState | null;
  selectedCardIds: ReadonlySet<string>;
  busy: boolean;
  action: (route: string, body?: unknown) => Promise<PosterState | null>;
  onError: (msg: string) => void;
  onState: (next: PosterState) => void;
  onMessage: (text: string) => void;
}): {
  drafts: MaterialDraft[];
  dirtyMaterials: boolean;
  matrixRef: MutableRefObject<PosterMaterialMatrixHandle | null>;
  persistedMaterialIds: Set<string>;
  validMaterialIds: string[];
  activeBatchMaterialIds: string[];
  persistMaterials: (
    itemsToSave?: MaterialDraft[],
    options?: { replaceAll?: boolean },
  ) => Promise<PosterState | null>;
  commitMatrixPending: () => void;
  handleThumbnailSaved: (id: string) => void;
  ensureMaterialsPersisted: (ids: string | readonly string[]) => Promise<boolean>;
  onAddLocalFiles: (paths: readonly string[]) => void;
  onDeleteCard: (id: string) => void;
  onBatchDeleteCards: (ids: readonly string[]) => void;
  onBatchUpdateCards: (ids: readonly string[], patch: Partial<MaterialDraft>) => void;
  onSaveEditItem: (updated: MaterialDraft, isNew: boolean) => Promise<boolean>;
  onMatrixChange: (next: MaterialDraft[]) => void;
  onDeleteMatrixSelected: (ids: string[]) => Promise<void>;
  setDrafts: Dispatch<SetStateAction<MaterialDraft[]>>;
} {
  const [drafts, setDrafts] = useState<MaterialDraft[]>(() => [createEmptyMaterialDraft()]);
  const [dirtyMaterials, setDirtyMaterials] = useState(false);
  const matrixRef = useRef<PosterMaterialMatrixHandle | null>(null);
  const editSeqRef = useRef(0);
  const autoSaveFailedSeqRef = useRef<number | null>(null);
  const onStateRef = useRef(onState);
  const onMessageRef = useRef(onMessage);
  const serverMaterialsRef = useRef(state?.materials ?? []);
  onStateRef.current = onState;
  onMessageRef.current = onMessage;
  serverMaterialsRef.current = state?.materials ?? [];
  useEffect(() => {
    if (!state) return;
    if (!dirtyMaterials)
      return setDrafts((prev) => mergeServerMaterialsIntoDrafts(prev, state.materials));
    const byId = new Map(state.materials.map((m) => [m.id, toMaterialDraft(m)]));
    setDrafts((prev) =>
      prev.map((d) => {
        const s = byId.get(d.id);
        return s
          ? {
              ...d,
              localFilePath: s.localFilePath,
              mediaKind: s.mediaKind,
              cacheStatus: s.cacheStatus,
              cacheError: s.cacheError,
              usedCount: s.usedCount,
              updatedAt: s.updatedAt,
              lastUsedAt: s.lastUsedAt ?? null,
              hasThumbnail: Boolean(s.hasThumbnail),
            }
          : d;
      }),
    );
  }, [state, dirtyMaterials]);
  const persistedMaterialIds = new Set((state?.materials ?? []).map((m) => m.id));
  const validMaterialIds = useMemo(
    () => drafts.filter(hasPosterMaterialContent).map((d) => d.id),
    [drafts],
  );
  const activeBatchMaterialIds = useMemo(() => {
    const picked = validMaterialIds.filter((id) => selectedCardIds.has(id));
    return picked.length > 0 ? picked : validMaterialIds;
  }, [validMaterialIds, selectedCardIds]);
  async function persistMaterials(itemsToSave = drafts, options?: { replaceAll?: boolean }) {
    const replaceAll = options?.replaceAll ?? true;
    const latest = replaceAll
      ? (matrixRef.current?.commitPendingEdit() ?? itemsToSave)
      : itemsToSave;
    const seq = editSeqRef.current;
    const valid = toMaterialInputs(latest);
    const next = await action('materials/save', { items: valid, replaceAll });
    if (next) {
      autoSaveFailedSeqRef.current = null;
      if (editSeqRef.current === seq) {
        setDirtyMaterials(false);
        setDrafts((prev) =>
          mergeServerMaterialsIntoDrafts(replaceAll ? latest : prev, next.materials),
        );
      }
      onMessage(`已保存 ${valid.length} 条发帖素材（含 Google Drive 媒体将在后台自动下载缓存）`);
    }
    return next;
  }
  useEffect(() => {
    if (!dirtyMaterials || busy) return;
    const seq = editSeqRef.current;
    if (autoSaveFailedSeqRef.current === seq) return;
    const timer = setTimeout(() => {
      if (matrixRef.current?.isEditing() || editSeqRef.current !== seq) return;
      const valid = toMaterialInputs(drafts);
      if (
        JSON.stringify(valid) ===
        JSON.stringify(toMaterialInputs(serverMaterialsRef.current.map(toMaterialDraft)))
      ) {
        if (editSeqRef.current === seq) setDirtyMaterials(false);
        return;
      }
      void api.posterAction('materials/save', { items: valid, replaceAll: true }).then(
        (next) => {
          autoSaveFailedSeqRef.current = null;
          onStateRef.current(next);
          if (editSeqRef.current === seq) setDirtyMaterials(false);
        },
        (err) => {
          autoSaveFailedSeqRef.current = seq;
          const msg = errMsg(err, '自动保存素材失败，请手动点击保存');
          onError(msg);
          onMessageRef.current(msg);
        },
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [drafts, dirtyMaterials, busy]);
  const removeCards = (ids: readonly string[]) => {
    const idSet = new Set(ids);
    const rem = drafts.filter((d) => !idSet.has(d.id) && hasPosterMaterialContent(d));
    setDrafts(rem.length > 0 ? rem : [createEmptyMaterialDraft()]);
    const toRemove = ids.filter((id) => persistedMaterialIds.has(id));
    if (toRemove.length > 0) void action('materials/delete', { ids: toRemove });
  };
  return {
    drafts,
    setDrafts,
    dirtyMaterials,
    matrixRef,
    persistedMaterialIds,
    validMaterialIds,
    activeBatchMaterialIds,
    persistMaterials,
    commitMatrixPending: () => {
      const c = matrixRef.current?.commitPendingEdit();
      if (!c) return;
      editSeqRef.current += 1;
      setDrafts(c);
      setDirtyMaterials(true);
    },
    handleThumbnailSaved: (id: string) =>
      setDrafts((prev) =>
        prev.map((d) => (d.id === id ? { ...d, hasThumbnail: true, updatedAt: Date.now() } : d)),
      ),
    ensureMaterialsPersisted: async (ids: string | readonly string[]) => {
      const list = Array.isArray(ids) ? ids : [ids];
      return (
        (!dirtyMaterials && list.every((id) => persistedMaterialIds.has(id))) ||
        Boolean(await persistMaterials(drafts))
      );
    },
    onAddLocalFiles: (paths: readonly string[]) => {
      const cleanPaths = paths.map((p) => p.trim()).filter(Boolean);
      if (!cleanPaths.length) return;
      const now = Date.now();
      const added = cleanPaths.map((p, idx): MaterialDraft => ({
        ...createEmptyMaterialDraft(`mat-${now}-${idx}-${crypto.randomUUID().slice(0, 6)}`),
        mediaSource: p,
        background: 'plain',
        aiLabel: 'default',
        createdAt: now,
      }));
      editSeqRef.current += 1;
      setDrafts((prev) => [...prev.filter(hasPosterMaterialContent), ...added]);
      void persistMaterials(added, { replaceAll: false });
    },
    onDeleteCard: (id: string) => removeCards([id]),
    onBatchDeleteCards: removeCards,
    onBatchUpdateCards: (ids: readonly string[], patch: Partial<MaterialDraft>) => {
      const { next, updated } = applyBatchMaterialPatch(drafts, ids, patch);
      editSeqRef.current += 1;
      setDrafts(next);
      void persistMaterials(updated, { replaceAll: false });
    },
    onSaveEditItem: async (updated: MaterialDraft, isNew: boolean) => {
      editSeqRef.current += 1;
      setDrafts((prev) => {
        const v = prev.filter(hasPosterMaterialContent);
        return isNew ? [...v, updated] : v.map((d) => (d.id === updated.id ? updated : d));
      });
      return Boolean(await persistMaterials([updated], { replaceAll: false }));
    },
    onMatrixChange: (next: MaterialDraft[]) => {
      editSeqRef.current += 1;
      setDrafts(next);
      setDirtyMaterials(true);
    },
    onDeleteMatrixSelected: async (ids: string[]) => {
      const idSet = new Set(ids);
      const rem = drafts.filter((d) => !idSet.has(d.id));
      editSeqRef.current += 1;
      setDirtyMaterials(false);
      setDrafts(rem.length > 0 ? rem : [createEmptyMaterialDraft()]);
      const toRemove = ids.filter((id) => persistedMaterialIds.has(id));
      if (toRemove.length > 0) await action('materials/delete', { ids: toRemove });
    },
  };
}
