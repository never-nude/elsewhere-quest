// STUB — owned by the save agent. Contract:
// openSaveSheet(ed, { captions }) — opens #sheet, starts the JPEG encode at once (cached by
// ed.revision), and on "Save to Photos" calls navigator.share({ files: [file] }) synchronously in
// the click handler. AbortError: no-op. No share support / other failure: #fallback long-press view.
// Success: "Done. It's the newest photo in Photos." and ed.markSaved().
export function openSaveSheet(ed) {
  ed.toast('Saving is being built');
}
