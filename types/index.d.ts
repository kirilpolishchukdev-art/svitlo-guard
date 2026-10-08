// Контракт значень svitlo у $.state: плашка над полем вводу.

export type SvitloBand = {
  // Ідентифікатор плашки: «Сховати» ховає саме її, нова з'явиться знову.
  id: string
  tone: 'warn' | 'resume'
  text: string
  // Команда для відновлення сесії, яку кнопка копіює в буфер.
  command?: string
}

declare module 'claude-code' {
  interface PluginState {
    svitlo: { band: SvitloBand | null; bandHidden: string }
  }
}
