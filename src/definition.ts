import type * as lsp from "vscode-languageserver-protocol"
import {EditorView, Command, KeyBinding} from "@codemirror/view"
import {LSPPlugin} from "./plugin"

type DefinitionResponse = lsp.Location | lsp.Location[] | lsp.LocationLink[] | null

function getDefinition(plugin: LSPPlugin, pos: number) {
  return plugin.client.request<lsp.DefinitionParams, DefinitionResponse>("textDocument/definition", {
    textDocument: {uri: plugin.uri},
    position: plugin.toPosition(pos)
  })
}

function getDeclaration(plugin: LSPPlugin, pos: number) {
  return plugin.client.request<lsp.DeclarationParams, DefinitionResponse>("textDocument/declaration", {
    textDocument: {uri: plugin.uri},
    position: plugin.toPosition(pos)
  })
}

function getTypeDefinition(plugin: LSPPlugin, pos: number) {
  return plugin.client.request<lsp.TypeDefinitionParams, DefinitionResponse>("textDocument/typeDefinition", {
    textDocument: {uri: plugin.uri},
    position: plugin.toPosition(pos)
  })
}

function getImplementation(plugin: LSPPlugin, pos: number) {
  return plugin.client.request<lsp.ImplementationParams, DefinitionResponse>("textDocument/implementation", {
    textDocument: {uri: plugin.uri},
    position: plugin.toPosition(pos)
  })
}

/// Normalize a definition response to a {uri, range} pair.
/// Handles Location, LocationLink, arrays of either, and null/empty.
function normalizeLocation(response: DefinitionResponse): {uri: string, range: lsp.Range} | null {
  if (!response) return null
  let item: lsp.Location | lsp.LocationLink | undefined
  if (Array.isArray(response)) {
    if (response.length === 0) return null
    item = response[0]
  } else {
    item = response
  }
  if (!item) return null
  // LocationLink has targetUri/targetRange; Location has uri/range
  if ("targetUri" in item) {
    return {uri: item.targetUri, range: item.targetSelectionRange || item.targetRange}
  }
  return {uri: (item as lsp.Location).uri, range: (item as lsp.Location).range}
}

function jumpToOrigin(view: EditorView, type: {get: typeof getDefinition, capability: keyof lsp.ServerCapabilities}): boolean {
  const plugin = LSPPlugin.get(view)
  if (!plugin || plugin.client.hasCapability(type.capability) === false) return false

  // Capture the cursor's vertical position within the visible scroller
  // so we can place the target at the same screen Y after the jump,
  // minimizing how far the user's eyes need to move.
  const head = view.state.selection.main.head
  const coords = view.coordsAtPos(head)
  const scrollerRect = view.scrollDOM.getBoundingClientRect()
  const cursorOffsetY = coords ? coords.top - scrollerRect.top : scrollerRect.height * 0.3

  plugin.client.sync()
  plugin.client.withMapping(mapping => type.get(plugin, head).then(response => {
    let loc = normalizeLocation(response)
    if (!loc) return
    return (loc.uri == plugin.uri ? Promise.resolve(view) : plugin.client.workspace.displayFile(loc.uri)).then(target => {
      if (!target) return
      let pos = mapping.getMapping(loc.uri) ? mapping.mapPosition(loc.uri, loc.range.start)
        : plugin.fromPosition(loc.range.start, target.state.doc)
      // Place the definition at the same vertical screen position as the
      // cursor was before the jump. Clamp the margin so it stays valid.
      let visibleH = target.scrollDOM.clientHeight || target.dom.clientHeight
      let margin = Math.max(5, Math.min(cursorOffsetY, visibleH - 30))
      target.dispatch({
        selection: {anchor: pos},
        effects: EditorView.scrollIntoView(pos, {y: "start", yMargin: margin}),
        userEvent: "select.definition",
      })
    })
  }, error => plugin.reportError("Find definition failed", error)))
  return true
}

/// Jump to the definition of the symbol at the cursor. To support
/// cross-file jumps, you'll need to implement
/// [`Workspace.displayFile`](#lsp-client.Workspace.displayFile).
export const jumpToDefinition: Command = view => jumpToOrigin(view, {
  get: getDefinition,
  capability: "definitionProvider"
})

/// Jump to the declaration of the symbol at the cursor.
export const jumpToDeclaration: Command = view => jumpToOrigin(view, {
  get: getDeclaration,
  capability: "declarationProvider"
})

/// Jump to the type definition of the symbol at the cursor.
export const jumpToTypeDefinition: Command = view => jumpToOrigin(view, {
  get: getTypeDefinition,
  capability: "typeDefinitionProvider"
})

/// Jump to the implementation of the symbol at the cursor.
export const jumpToImplementation: Command = view => jumpToOrigin(view, {
  get: getImplementation,
  capability: "implementationProvider"
})

/// Binds F12 to [`jumpToDefinition`](#lsp-client.jumpToDefinition).
export const jumpToDefinitionKeymap: readonly KeyBinding[] = [
  {key: "F12", run: jumpToDefinition, preventDefault: true},
]
