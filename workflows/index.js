// Workflow service entrypoint (npm start -> node index.js).
//
// Render Workflows registers a task when its task() wrapper runs, so importing
// tasks.js is all the worker needs to do — Render discovers ingestMetro and
// ingestTile from the registered set and drives their execution. We re-export
// them so they're also importable for local/manual invocation.
export { ingestMetro, ingestTile } from './tasks.js';
