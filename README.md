# EOIOT Protocol Studio

源一物联仪表协议解析与调试工作台。当前首版采用 React、TypeScript 与 Vite，解析过程完全在浏览器本地完成。

## 已实现

- CJ/T 188 小口径水表解析
- 武汉沃特曼 9021、9023、9025 解析器
- 自动识别协议与手动指定解析器
- 字段偏移、HEX 字节地图、诊断和 JSON 输出
- 沃特曼历史数据、流量、压力、温度、电压、设备信息和告警字段
- 白天 / 夜间主题切换
- 插件式协议注册表

## 本地运行

```bash
pnpm install
pnpm dev
```

生产构建：

```bash
pnpm build
```

## 部署到 GitHub Pages

仓库包含 `.github/workflows/pages.yml`。将代码推送到 `main` 后，在 GitHub 仓库的
`Settings → Pages → Build and deployment` 中选择 `GitHub Actions`，工作流会自动构建并发布 `dist`。

Vite 使用相对资源路径，因此部署到 `https://<用户名>.github.io/<仓库名>/` 时无需修改仓库名配置。

## 目录结构

```text
app/studio.tsx          工作台界面与交互
app/globals.css         设计系统与响应式样式
lib/protocols/          协议解析内核
src/main.tsx            浏览器入口
```

新增协议只需实现 `ProtocolParser` 接口，并加入 `lib/protocols/registry.ts`。
