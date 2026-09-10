import { invoke } from '@tauri-apps/api/core'

export const api = {
  listConnections: () => invoke('list_connections'),
  saveConnection: (config) => invoke('save_connection', { config }),
  deleteConnection: (id) => invoke('delete_connection', { id }),
  testConnection: (config) => invoke('test_connection', { config }),
  connect: (config) => invoke('connect_db', { config }),
  disconnect: (id) => invoke('disconnect_db', { id }),
  listDatabases: (session) => invoke('list_databases', { session }),
  listTables: (session, db) => invoke('list_tables', { session, db }),
  getTableMeta: (session, db, table) => invoke('get_table_meta', { session, db, table }),
  fetchRows: (args) => invoke('fetch_rows', args),
  updateCell: (args) => invoke('update_cell', args),
  insertRow: (args) => invoke('insert_row', args),
  deleteRows: (args) => invoke('delete_rows', args),
  executeSql: (args) => invoke('execute_sql', args),
  exportCsv: (args) => invoke('export_csv', args),
  exportJson: (args) => invoke('export_json', args),
  exportXlsx: (args) => invoke('export_xlsx', args),
  exportInserts: (args) => invoke('export_inserts', args),
  listSavedQueries: (connId, db) => invoke('list_saved_queries', { connId, db }),
  saveQuery: (query) => invoke('save_query', { query }),
  deleteQuery: (id) => invoke('delete_query', { id }),
  // SQL 脚本文件（打开外部 .sql / 保存为文件 / 在文件管理器中定位）
  readSqlFile: (path) => invoke('read_sql_file', { path }),
  writeSqlFile: (path, content) => invoke('write_sql_file', { path, content }),
  revealPath: (path) => invoke('reveal_in_file_manager', { path }),
}
