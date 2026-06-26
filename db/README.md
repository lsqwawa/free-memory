# 数据库初始化

## 方案 A：命令行
1. 使用超级账号连接 PostgreSQL：
   - 工具路径示例：`D:\application\PostgreSQL\16\bin\psql.exe`
   - 登录示例：`psql -U postgres -h 127.0.0.1 -p 5432`
2. 创建数据库与应用用户：
   - `CREATE USER changji WITH PASSWORD 'ChangJi@2026';`
   - `CREATE DATABASE changji OWNER changji;`
3. 切换到业务库并执行建表脚本：
   - `\c changji`
   - `\i db/init.sql`

## 方案 B：pgAdmin 4
1. 在 `Servers` 右键新建查询窗口
2. 执行用户与库创建 SQL
3. 切换到 `changji` 数据库
4. 执行 `db/init.sql`
