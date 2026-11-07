/**
 * Presenter control for semantic mode: hold a visible snapshot while the
 * background keeps understanding, resume directly onto the latest state, and
 * pin archived scenes for explicit review. It owns no DOM; the renderer and
 * the store do the actual work, which keeps this logic testable in Node.
 */
export class SemanticPresenter {
  constructor({ store, renderer, onStatus = null } = {}) {
    if (!store) throw new Error('store is required');
    if (!renderer) throw new Error('renderer is required');
    this.store = store;
    this.renderer = renderer;
    this.onStatus = onStatus;
    this.held = false;
    this.pinnedSceneId = null;
    this.heldAt = 0;
    this.heldSceneId = null;
    this.skipped = 0;
  }

  #status(text) {
    if (this.onStatus) this.onStatus(text);
  }

  /** Commits during hold update the store but deliberately not the screen. */
  render(state, options = {}) {
    if (this.held) {
      this.skipped += 1;
      return false;
    }
    return this.renderer.render(state, options);
  }

  hold() {
    if (this.held) return false;
    this.held = true;
    this.heldAt = Date.now();
    this.heldSceneId = this.renderer.sceneId || null;
    this.skipped = 0;
    this.#status('held');
    return true;
  }

  /** Jump straight to the latest valid state; never replay skipped frames. */
  resume() {
    if (!this.held) return false;
    this.held = false;
    const state = this.store.snapshot();
    this.renderer.render(state, { animate: false, reason: 'resume' });
    this.skipped = 0;
    this.#status('resumed');
    return true;
  }

  /** Explicit review of an archived scene; does not change active_scene_id. */
  pin(sceneId) {
    if (!sceneId || !this.store.snapshot().scenes[sceneId]) return false;
    this.pinnedSceneId = sceneId;
    this.renderer.showScene(sceneId);
    this.#status('pinned');
    return true;
  }

  unpin() {
    if (!this.pinnedSceneId) return false;
    this.pinnedSceneId = null;
    this.renderer.showScene(null);
    this.#status('unpinned');
    return true;
  }

  get pinned() {
    return Boolean(this.pinnedSceneId);
  }

  editNode(id, { label, claim_kind } = {}) {
    const node = this.store.snapshot().nodes[id];
    if (!node) return { ok: false, code: 'not_found', errors: [`node ${id} not found`] };
    const patch = { id };
    if (label !== undefined) patch.label = label;
    if (claim_kind !== undefined) patch.claim_kind = claim_kind;
    return this.#apply([{ op: 'upsert_node', node: patch }]);
  }

  editEdge(id, { label, relation } = {}) {
    const edge = this.store.snapshot().edges[id];
    if (!edge) return { ok: false, code: 'not_found', errors: [`edge ${id} not found`] };
    const patch = { id };
    if (label !== undefined) patch.label = label;
    if (relation !== undefined) patch.relation = relation;
    return this.#apply([{ op: 'upsert_edge', edge: patch }]);
  }

  retract(id) {
    return this.#apply([{ op: 'retract', id, reason: 'manual' }]);
  }

  #apply(ops) {
    const result = this.store.applyManual(ops);
    if (result.ok) {
      this.renderer.render(this.store.snapshot(), { animate: false, reason: 'manual' });
      this.#status('edited');
    }
    return result;
  }
}
