/** AdminPushConfig 类型, 跟 routes/admin/push.ts 的 zod schema 对应.
 *  从 notifier 单独 import, 避免 notifier 反向依赖 routes 层。 */
export interface AdminPushConfig {
  wechat_work: {
    enabled: boolean;
    webhook_url: string;
  };
  smtp: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  };
}
