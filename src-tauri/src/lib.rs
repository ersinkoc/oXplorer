mod archive_fs;
mod dir;
mod error;
mod git;
mod integration;
mod jobs;
mod mac;
mod menu;
mod model;
mod preview;
mod pty;
mod remote;
mod search;
mod security;
mod system;
mod uri_scheme;
mod usage;
mod windows;

use tauri::Manager as _;
use tauri_specta::{collect_commands, collect_events};

pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            dir::open_dir,
            dir::stat_path,
            dir::complete_path,
            dir::watch_dir,
            dir::unwatch_dir,
            jobs::start_job,
            jobs::cancel_job,
            jobs::resolve_conflict,
            jobs::measure,
            jobs::rename_path,
            jobs::create_item,
            jobs::make_symlink,
            jobs::checksum,
            jobs::set_permissions,
            jobs::pause_job,
            jobs::batch_rename,
            integration::pasteboard_write_files,
            integration::pasteboard_read_files,
            integration::apps_for_path,
            integration::open_with,
            integration::drag_preview,
            integration::edit_tags,
            integration::quick_look,
            integration::quick_look_close,
            integration::quick_look_visible,
            preview::preview_text,
            preview::allow_preview,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            search::search_start,
            search::search_cancel,
            system::favorite_tags,
            system::log_file,
            system::updates_enabled,
            git::git_status,
            usage::disk_usage,
            usage::disk_usage_cancel,
            archive_fs::archive_list,
            archive_fs::archive_open_member,
            remote::remote_set_connections,
            remote::remote_save_secret,
            remote::remote_has_secret,
            remote::remote_test,
            remote::remote_list,
            remote::remote_create_dir,
            remote::remote_rename,
            remote::remote_delete,
            remote::remote_open_member,
            remote::remote_register_test_folder,
            menu::menu_items,
            menu::set_shortcuts,
            menu::set_menu_titles,
            menu::open_settings,
            system::home_dir,
            system::launch_dir,
            system::self_test_dir,
            system::standard_locations,
            system::list_volumes,
            system::eject_volume,
            system::space_for,
            system::check_full_disk_access,
            system::open_path,
            system::reveal_in_finder,
            system::open_full_disk_access_settings,
            system::take_open_requests,
            windows::open_window,
            windows::window_start_path,
        ])
        .events(collect_events![
            menu::MenuCommand,
            model::DirChanged,
            model::QuickLookState,
            model::QuickLookKey,
            model::OpenRequested,
        ])
}

pub fn export_bindings(builder: &tauri_specta::Builder<tauri::Wry>, path: &str) {
    builder
        .export(
            specta_typescript::Typescript::default()
                .header("// @ts-nocheck\n/* eslint-disable */\n// biome-ignore-all lint: generated file"),
            path,
        )
        .expect("failed to export typescript bindings");
}

/// Panics end up in the log file (release builds abort right after), so a
/// "Report a Problem" can include what happened.
fn log_panics() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}\n{}", std::backtrace::Backtrace::force_capture());
        log::logger().flush();
        default(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_panics();
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings(&builder, "../src/bindings.ts");

    tauri::Builder::default()
        // Must be registered first so a second launch focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(w) = windows::primary(app) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            system::request_open(app, system::paths_from_args(&args, &cwd));
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(builder.invoke_handler())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::forward_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(ptys) = window.try_state::<std::sync::Arc<pty::PtyManager>>() {
                    ptys.close_window(window.label());
                }
                if let Some(watcher) = window.try_state::<dir::DirWatcher>() {
                    watcher.release_window(window.label());
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol(uri_scheme::SCHEME, uri_scheme::handle)
        .manage(system::OpenRequests::default())
        .manage(menu::MenuConfig::default())
        .setup(move |app| {
            builder.mount_events(app);
            if let Some(window) = app.get_webview_window("main") {
                mac::quicklook::install(app.handle(), &window);
            }
            app.manage(dir::DirWatcher::new(app.handle().clone())?);
            app.manage(std::sync::Arc::new(jobs::JobManager::default()));
            app.manage(std::sync::Arc::new(pty::PtyManager::default()));
            app.manage(std::sync::Arc::new(search::SearchManager::default()));
            app.manage(std::sync::Arc::new(usage::UsageScans::default()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OXplorer")
        .run(|app, event| {
            // Folders dropped on the Dock icon or sent with `open -a OXplorer <dir>`.
            if let tauri::RunEvent::Opened { urls } = event {
                system::request_open(app, urls.iter().filter_map(|u| u.to_file_path().ok()));
            }
        });
}

#[cfg(test)]
mod tests {
    /// `cargo test export_bindings` regenerates `src/bindings.ts` without launching the app.
    #[test]
    fn export_bindings() {
        super::export_bindings(&super::specta_builder(), "../src/bindings.ts");
    }
}
