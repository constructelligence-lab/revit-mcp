// Live resources: the state of the bridge as something a client can attach, rather than something it has
// to spend a tool call on. Read on demand — a resource is a view of the model right now, never a cache.
export const RESOURCES = [
  {
    uri: 'revit://status',
    name: 'Revit status',
    description: 'Which document is open, the Revit version, and whether the bridge will accept writes. Read this before blaming a tool for failing.',
    op: 'status',
  },
  {
    uri: 'revit://model/overview',
    name: 'Model overview',
    description: 'Counts and the biggest categories in the open model — the same answer model_overview gives.',
    op: 'model.overview',
  },
  {
    uri: 'revit://warnings',
    name: 'Model warnings',
    description: "Revit's own warnings for the open model, live. A warning is a prompt to look, not a finding.",
    op: 'warnings.list',
  },
];
