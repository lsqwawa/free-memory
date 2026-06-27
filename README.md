# FreeMemory

FreeMemory 是一个用于上传 PDF、识别信息重点、自动创建填空题并反复练习的便携记背工具。

## 技术栈
- 前端：React + React Router + Redux Toolkit + TypeScript + Vite
- 后端：Node.js + Express + TypeScript
- 数据库：PostgreSQL

## 目录结构
- `apps/web`：前端应用
- `apps/server`：后端 API
- `db/init.sql`：数据库表结构
- `db/bootstrap.sql`：可选的快速初始化脚本

## 数据库初始化
当前项目默认对接本地 PostgreSQL 数据库 `FreeMemory`：

```
postgresql://postgres:<your_password>@localhost:5432/FreeMemory?schema=public
```

如果你已经手动创建了数据库和账号，可以直接对目标库执行：

```
psql -U postgres -d FreeMemory -f db/init.sql
```

如需使用独立账号，可执行 `db/bootstrap.sql`，再对目标库执行 `db/init.sql`。

## 后端启动
1. 进入 `apps/server`
2. 复制 `.env.example` 为 `.env`
3. 安装依赖：`npm install`
4. 启动开发服务：`npm run dev`

默认健康检查：`http://localhost:4000/api/v1/health`

## 前端启动
1. 进入 `apps/web`
2. 安装依赖：`npm install`
3. 启动开发服务：`npm run dev`

默认访问：`http://localhost:5173`

## 当前能力
- 注册登录
- PDF 文档上传
- 上传后自动解析红蓝重点
- 自动生成真题
- 按文档加载真题练习
- 学习统计页
- 移动端底部自适应导航
