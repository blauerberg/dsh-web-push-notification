import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { WebPushSettingsSection } from '../src/client/WebPushSettingsSection.tsx'

export async function renderSettings(): Promise<ReactTestRenderer> {
  let panel!: ReactTestRenderer
  await act(async () => {
    panel = create(
      createElement(WebPushSettingsSection, {
        close() {},
        useWorkspaces() {
          throw new Error('Settings do not read the workspace')
        },
      }),
    )
  })
  return panel
}

export function checkbox(panel: ReactTestRenderer, label: string) {
  const row = panel.root
    .findAllByType('label')
    .find((item) => item.findAllByType('span').some((span) => span.children.includes(label)))
  if (row === undefined) throw new Error(`Missing settings label: ${label}`)
  return row.findByType('input')
}
