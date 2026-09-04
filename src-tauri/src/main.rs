#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mysql_studio_tauri_lib::run();
}
