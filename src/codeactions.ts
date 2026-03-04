import type * as lsp from "vscode-languageserver-protocol"
import {setDiagnostics, type Diagnostic} from "@codemirror/lint"
import {ViewPlugin, ViewUpdate} from "@codemirror/view"
import {LSPPlugin} from "./plugin"
import {LSPClientExtension, LSPClient} from "./client"

function toSeverity(sev: lsp.DiagnosticSeverity) {
  return sev == 1 ? "error" : sev == 2 ? "warning" : sev == 3 ? "info" : "hint"
}

const autoSync = ViewPlugin.fromClass(class {
  pending = -1
  update(update: ViewUpdate) {
    if (update.docChanged) {
      if (this.pending > -1) clearTimeout(this.pending)
      this.pending = setTimeout(() => {
        this.pending = -1
        let plugin = LSPPlugin.get(update.view)
        if (plugin) plugin.client.sync()
      }, 500)
    }
  }
  destroy() {
    if (this.pending > -1) clearTimeout(this.pending)
  }
})

/// Returns an LSP client extension that handles diagnostics from the
/// server and, when the server supports it, fetches code actions for
/// those diagnostics and attaches them as quick-fix actions.
///
/// This is a superset of
/// [`serverDiagnostics`](#lsp-client.serverDiagnostics)—do not use
/// both at the same time.
export function serverCodeActions(): LSPClientExtension {
  return {
    clientCapabilities: {
      textDocument: {
        publishDiagnostics: {versionSupport: true},
        codeAction: {
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: [
                "quickfix", "refactor", "refactor.extract",
                "refactor.inline", "refactor.rewrite",
                "source", "source.organizeImports"
              ]
            }
          }
        }
      }
    },
    notificationHandlers: {
      "textDocument/publishDiagnostics": (client, params: lsp.PublishDiagnosticsParams) => {
        let file = client.workspace.getFile(params.uri)
        if (!file || params.version != null && params.version != file.version) return false
        const view = file.getView(), plugin = view && LSPPlugin.get(view)
        if (!view || !plugin) return false

        let cmDiagnostics: Diagnostic[] = params.diagnostics.map(item => ({
          from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
          to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
          severity: toSeverity(item.severity ?? 1),
          message: item.message,
          source: item.source || undefined,
        }))
        view.dispatch(setDiagnostics(view.state, cmDiagnostics))

        // Fetch code actions asynchronously and update diagnostics with actions
        if (client.serverCapabilities?.codeActionProvider && params.diagnostics.length > 0) {
          fetchCodeActions(client, plugin, params, cmDiagnostics)
        }

        return true
      }
    },
    editorExtension: autoSync
  }
}

function fetchCodeActions(
  client: LSPClient,
  plugin: LSPPlugin,
  params: lsp.PublishDiagnosticsParams,
  cmDiagnostics: Diagnostic[]
) {
  Promise.all(
    params.diagnostics.map(diag =>
      client.request<lsp.CodeActionParams, (lsp.Command | lsp.CodeAction)[] | null>(
        "textDocument/codeAction",
        {
          textDocument: {uri: params.uri},
          range: diag.range,
          context: {diagnostics: [diag]}
        }
      ).catch(() => null)
    )
  ).then(results => {
    let hasActions = false
    let updated = cmDiagnostics.map((diag, i) => {
      let actions = results[i]
      if (!actions?.length) return diag
      hasActions = true
      return {
        ...diag,
        actions: actions.map(action => ({
          name: action.title,
          apply: () => {
            if ("edit" in action && action.edit) {
              applyWorkspaceEdit(client, plugin, action.edit)
            }
          }
        }))
      }
    })
    if (hasActions) {
      try { plugin.view.dispatch(setDiagnostics(plugin.view.state, updated)) }
      catch(e) { /* view may have been destroyed */ }
    }
  })
}

function applyWorkspaceEdit(client: LSPClient, plugin: LSPPlugin, edit: lsp.WorkspaceEdit) {
  if (edit.changes) {
    for (let uri in edit.changes) {
      let changes = edit.changes[uri]
      if (!changes.length) continue
      client.workspace.updateFile(uri, {
        changes: changes.map(c => ({
          from: plugin.fromPosition(c.range.start),
          to: plugin.fromPosition(c.range.end),
          insert: c.newText
        })),
        userEvent: "codeAction"
      })
    }
  }
  if (edit.documentChanges) {
    for (let docChange of edit.documentChanges) {
      if ("textDocument" in docChange) {
        client.workspace.updateFile((docChange as lsp.TextDocumentEdit).textDocument.uri, {
          changes: (docChange as lsp.TextDocumentEdit).edits.map(e => {
            let edit = e as lsp.TextEdit
            return {
              from: plugin.fromPosition(edit.range.start),
              to: plugin.fromPosition(edit.range.end),
              insert: edit.newText
            }
          }),
          userEvent: "codeAction"
        })
      }
    }
  }
}
