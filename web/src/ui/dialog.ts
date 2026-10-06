import { h } from '../research-dom'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

/** Confirmação acessível (usa <dialog> nativo: foco preso, Esc cancela). Resolve true só se confirmar. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-text' })
    let answer = false
    const confirm = h('button', { type: 'button', class: options.danger ? 'btn btn-danger' : 'btn btn-primary', onClick: () => { answer = true; dialog.close() } }, options.confirmLabel ?? 'Confirmar')
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => dialog.close() }, options.cancelLabel ?? 'Cancelar')
    dialog.append(
      h('h2', { id: 'confirm-title', class: 'modal-title' }, options.title),
      h('p', { id: 'confirm-text', class: 'modal-text' }, options.message),
      h('div', { class: 'modal-actions' }, cancel, confirm)
    )
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(answer)
    })
    // clique no fundo (fora da caixa) cancela
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close()
    })
    document.body.appendChild(dialog)
    dialog.showModal()
    cancel.focus()
  })
}
