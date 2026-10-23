// Native subject selection enters the same source-pixel polygon path as a
// traced Outline. Swift sees the current output, never a retained import.
import { outputToSource, multiply } from '../lib/geometry.js';
import { transformPolygon, polygonArea, polygonRecord, simplifyPolygon } from '../lib/lasso.js';
import { subjectAt, haptic } from './platform.js';

const MISS = 'No subject there. Loop around it instead.';

export function createSubjectLift({ request = subjectAt, feedback = haptic } = {}) {
  let generation = 0;
  let pending = false;

  function cancel(ed) {
    generation++;
    const wasPending = pending;
    pending = false;
    if (wasPending) ed?.refresh?.();
  }

  function tap(ed, x, y, { tool, commit, isCurrent = () => true, analysisPx = 1024, tiny = 16 } = {}) {
    cancel();
    const token = generation;
    const state = ed.committed, session = ed.session, revision = ed.revision, history = ed.history;
    const sameSession = () => ed.session === session && (ed.toolId === undefined || ed.toolId === tool);
    const fresh = () => token === generation && sameSession() && ed.committed === state &&
      ed.revision === revision && ed.history === history && isCurrent();
    if (!state) return false;
    pending = true;
    ed.refresh?.();
    void (async () => {
      try {
        const output = ed.outputSize();
        const [ox, oy] = ed.stageToDoc(x, y);
        if (!(ox >= 0 && oy >= 0 && ox < output.width && oy < output.height)) return;
        const image = ed.readOutput({ maxSide: analysisPx, tone: false });
        const kx = image.width / output.width, ky = image.height / output.height;
        feedback('light');
        const result = await request(image, ox * kx, oy * ky, { radius: 12 });
        if (!fresh()) return;
        if (!result?.found || !result.polygons?.length) {
          ed.toast?.(MISS);
          feedback('warning');
          return;
        }
        // Replies are validated by platform.js; choose by area here as well so
        // one disconnected subject still makes exactly one undo step.
        const largest = result.polygons.reduce((a, b) => polygonArea(a) >= polygonArea(b) ? a : b);
        const poly = simplifyPolygon(largest, 0.75);
        const areaPt = polygonArea(poly) / (kx * ky) * ed.view.scale ** 2;
        if (areaPt < tiny) {
          ed.toast?.(MISS);
          feedback('warning');
          return;
        }
        const toSource = multiply(outputToSource(state.crop, state.source.w, state.source.h), [1 / kx, 0, 0, 1 / ky, 0, 0]);
        const polyS = polygonRecord(transformPolygon(poly, toSource));
        commit(ed, polyS);
      } catch {
        if (fresh()) {
          ed.toast?.('Couldn’t find the subject. Loop around it instead.');
          feedback('warning');
        }
      } finally {
        if (token === generation) {
          pending = false;
          if (sameSession()) ed.refresh?.();
        }
      }
    })();
    return true;
  }

  return { tap, cancel, get pending() { return pending; } };
}
