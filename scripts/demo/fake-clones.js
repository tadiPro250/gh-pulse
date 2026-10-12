// Stand-in for src/clones.js used only by the demo recording: never looks at
// the real filesystem, so no local path can end up in the GIF.

export const workspaceRoots = () => [];
export const scanClones = () => [];
export const findClone = () => null;
export const defaultCloneTarget = (config, repo) => `~/code/${repo.split('/')[1]}`;
export const isClone = () => false;
