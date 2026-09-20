// The Workflow runtime uses these control exceptions for pause/restart/terminate.
// Do not turn them into business failures or consume a checkpoint while stopping.
export const isInterruption = error => /^Aborting engine: (User called (pause|restart|terminate)|Grace period complete)$/.test(error?.message || '');
