use tauri::Manager;

pub mod db;
use db::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&dir).ok();
            app.manage(AppState {
                pools: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
                tunnels: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
                data_dir: dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::list_connections,
            db::save_connection,
            db::delete_connection,
            db::test_connection,
            db::connect_db,
            db::disconnect_db,
            db::list_databases,
            db::list_tables,
            db::get_table_meta,
            db::fetch_rows,
            db::update_cell,
            db::insert_row,
            db::delete_rows,
            db::execute_sql,
            db::export_csv,
            db::export_inserts,
            db::list_saved_queries,
            db::save_query,
            db::delete_query,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
