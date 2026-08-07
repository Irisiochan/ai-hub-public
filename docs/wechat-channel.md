# 微信 iLink bot 通道

ai-hub 直接实现微信 iLink bot 的 HTTP 协议，不安装 OpenClaw。网关只主动向微信服务端
发起 HTTPS 长轮询和发送请求；微信不会连接 VPS，因此不新增端口、反代、域名或 IP 白名单。

## 路由与消息范围

- `Claude ...`、`/Claude ...`、`Codex ...`、`/Codex ...`、`阿野 ...`、`/阿野 ...` 显式选联系人。
- 未写名字时沿用最近一次目标，30 分钟内有效；过期后回复“发给谁？Claude / Codex / 阿野”。
- 模型回复统一加 `[联系人]` 前缀；超过 4000 字符时安全分片。
- 第一版支持文本和最多 4 张图片。图片从微信 CDN 下载后以 AES-128-ECB 解密，再走
  ai-hub 现有附件与视觉管线。
- 语音明确降级为“暂时听不懂语音，打字吧”；文件和视频暂不进入模型。
- 不在 `WECHAT_ALLOW_FROM` 的发送者直接丢弃，消息内容不会进入数据库或模型。

## 环境变量

只在 VPS 的 `/opt/ai-hub/.env` 配置，文件保持 `600`，不要把真实值写进 checkout：

```dotenv
WECHAT_CHANNEL_ENABLED=true
WECHAT_BOT_TOKEN=<扫码绑定得到的长期 bearer>
WECHAT_BOT_ID=<形如 xxxx@im.bot>
WECHAT_ALLOW_FROM=<允许联系 bot 的 ilink_user_id，多个用逗号分隔>
```

通常不需要覆盖以下默认值：

```dotenv
WECHAT_BASE_URL=https://ilinkai.weixin.qq.com
WECHAT_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
WECHAT_LONG_POLL_MS=35000
```

游标和 30 分钟 sticky 状态原子写入 `/var/lib/ai-hub/wechat-channel-state.json`，权限为
`600`；不包含 `bot_token` 或 `context_token`。收到的图片沿用 `server/data/uploads` 的
既有 `600` 权限与清理策略。

## 可靠性与观测

- `get_updates_buf` 在整批消息处理完成后才推进；消息用 `wechat:<message_id>` 做数据库
  幂等，回复使用稳定 `client_id`。已落库的模型终态会在重放时复用；微信服务端可用同一
  `client_id` 收敛发送确认前断线造成的重试。
- `errcode=-14` 按官方参考实现暂停一小时；普通网络失败 2 秒重试，连续三次失败退避 30 秒。
- `/api/health` 返回 `wechat.enabled/running/lastPollAt/lastInboundAt/lastOutboundAt/lastError`，
  不暴露 token、用户 ID、游标或上下文 token。
- 首版使用 typing 指示，但只发送模型终态；协议流式留作后续增量，不把半截正文发到微信。
