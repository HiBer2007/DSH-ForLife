/** 端口出口页的数据形状（与 GET /api/admin/ports 对齐）。 */
export interface PortRow {
  readonly id: string
  readonly name: string
  readonly target_port: number
  readonly protocol: string
  readonly ttl_seconds: number | null
  readonly expires_at: string | null
  readonly approved_by: string
  readonly note: string | null
  readonly created_at: string
}

export interface PortsOverview {
  /** 是否启用（没配 Caddy 时为 false，界面据此禁用按钮并显示原因）。 */
  readonly enabled: boolean
  readonly disabledReason?: string
  readonly whitelist: readonly { readonly from: number; readonly to: number }[]
  readonly rows: readonly (PortRow & { readonly url: string })[]
}
