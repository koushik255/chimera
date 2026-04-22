import sys
import webbrowser
from datetime import datetime

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtGui import QAction, QCloseEvent
from PySide6.QtWidgets import (
    QApplication,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QPlainTextEdit,
    QStyle,
    QSystemTrayIcon,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from host_service import HostService


class HostBridge(QObject):
    status_changed = Signal(dict)
    manifest_changed = Signal(dict)
    log_added = Signal(str)


class HostWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("chimera host")
        self.resize(900, 720)

        self.bridge = HostBridge()
        self.bridge.status_changed.connect(self._render_status)
        self.bridge.manifest_changed.connect(self._render_manifest)
        self.bridge.log_added.connect(self._append_log)

        self.service = HostService(
            enable_frontend=True,
            logger=self.bridge.log_added.emit,
            on_status=self.bridge.status_changed.emit,
            on_manifest=self.bridge.manifest_changed.emit,
        )
        self.tray_icon = self._build_tray_icon()
        self.close_to_tray_notified = False

        self.connection_value = QLabel("Starting...")
        self.backend_value = QLabel("Loading...")
        self.host_value = QLabel("Loading...")
        self.frontend_value = QLabel("Loading...")
        self.connected_at_value = QLabel("Never")
        self.last_error_value = QLabel("None")
        self.totals_value = QLabel("Loading...")

        self.series_table = QTableWidget(0, 3)
        self.series_table.setHorizontalHeaderLabels(["Series", "Volumes", "Pages"])
        self.series_table.horizontalHeader().setStretchLastSection(True)
        self.series_table.verticalHeader().setVisible(False)
        self.series_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.series_table.setSelectionMode(QTableWidget.SelectionMode.NoSelection)

        self.log_output = QPlainTextEdit()
        self.log_output.setReadOnly(True)
        self.log_output.setMaximumBlockCount(400)

        self._build_ui()
        self.service.start()

    def _build_ui(self) -> None:
        root = QWidget()
        outer = QVBoxLayout(root)
        outer.setContentsMargins(20, 20, 20, 20)
        outer.setSpacing(16)

        summary_box = QGroupBox("Runtime")
        summary_layout = QGridLayout(summary_box)
        summary_layout.addWidget(QLabel("Connection"), 0, 0)
        summary_layout.addWidget(self.connection_value, 0, 1)
        summary_layout.addWidget(QLabel("Backend"), 1, 0)
        summary_layout.addWidget(self.backend_value, 1, 1)
        summary_layout.addWidget(QLabel("Host"), 2, 0)
        summary_layout.addWidget(self.host_value, 2, 1)
        summary_layout.addWidget(QLabel("Local panel"), 3, 0)
        summary_layout.addWidget(self.frontend_value, 3, 1)
        summary_layout.addWidget(QLabel("Last connected"), 4, 0)
        summary_layout.addWidget(self.connected_at_value, 4, 1)
        summary_layout.addWidget(QLabel("Last error"), 5, 0)
        summary_layout.addWidget(self.last_error_value, 5, 1)
        summary_layout.addWidget(QLabel("Library totals"), 6, 0)
        summary_layout.addWidget(self.totals_value, 6, 1)

        actions_layout = QHBoxLayout()
        show_panel_button = QPushButton("Open local panel")
        show_panel_button.clicked.connect(self._open_local_panel)
        restart_button = QPushButton("Restart host")
        restart_button.clicked.connect(self._restart_host)
        hide_button = QPushButton("Hide to tray")
        hide_button.clicked.connect(self.hide)
        quit_button = QPushButton("Quit")
        quit_button.clicked.connect(self._quit_from_ui)

        actions_layout.addWidget(show_panel_button)
        actions_layout.addWidget(restart_button)
        actions_layout.addWidget(hide_button)
        actions_layout.addStretch(1)
        actions_layout.addWidget(quit_button)

        series_box = QGroupBox("Serving")
        series_layout = QVBoxLayout(series_box)
        series_layout.addWidget(self.series_table)

        logs_box = QGroupBox("Logs")
        logs_layout = QVBoxLayout(logs_box)
        logs_layout.addWidget(self.log_output)

        outer.addWidget(summary_box)
        outer.addLayout(actions_layout)
        outer.addWidget(series_box, 1)
        outer.addWidget(logs_box, 1)
        self.setCentralWidget(root)

    def _build_tray_icon(self) -> QSystemTrayIcon:
        tray_icon = QSystemTrayIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon), self)
        tray_icon.setToolTip("chimera host")

        menu = QMenu(self)
        show_action = QAction("Show chimera host", self)
        show_action.triggered.connect(self.show_from_tray)
        panel_action = QAction("Open local panel", self)
        panel_action.triggered.connect(self._open_local_panel)
        restart_action = QAction("Restart host", self)
        restart_action.triggered.connect(self._restart_host)
        quit_action = QAction("Quit", self)
        quit_action.triggered.connect(self._quit_from_ui)

        menu.addAction(show_action)
        menu.addAction(panel_action)
        menu.addAction(restart_action)
        menu.addSeparator()
        menu.addAction(quit_action)

        tray_icon.setContextMenu(menu)
        tray_icon.activated.connect(self._handle_tray_activation)
        tray_icon.show()
        return tray_icon

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.tray_icon.isVisible():
            event.ignore()
            self.hide()
            if not self.close_to_tray_notified:
                self.tray_icon.showMessage(
                    "chimera host",
                    "The host is still running in the system tray.",
                    QSystemTrayIcon.MessageIcon.Information,
                    2500,
                )
                self.close_to_tray_notified = True
            return

        super().closeEvent(event)

    def show_from_tray(self) -> None:
        self.show()
        self.raise_()
        self.activateWindow()

    def _handle_tray_activation(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason in {
            QSystemTrayIcon.ActivationReason.Trigger,
            QSystemTrayIcon.ActivationReason.DoubleClick,
        }:
            self.show_from_tray()

    def _render_status(self, status: dict) -> None:
        connection = "Connected" if status.get("connected") else "Disconnected"
        self.connection_value.setText(connection)

        backend = status.get("wsUrl") or "Unknown"
        self.backend_value.setText(backend)

        host_id = status.get("hostId") or "unknown"
        host_username = status.get("hostUsername") or "unknown"
        self.host_value.setText(f"{host_username} ({host_id})")

        if status.get("frontendEnabled"):
            self.frontend_value.setText(f"http://{status['frontendHost']}:{status['frontendPort']}")
        else:
            self.frontend_value.setText("Disabled")

        self.connected_at_value.setText(self._format_timestamp(status.get("lastConnectedAt")))
        self.last_error_value.setText(status.get("lastError") or "None")

    def _render_manifest(self, manifest: dict) -> None:
        self.totals_value.setText(
            f"{manifest['totalSeries']} series, {manifest['totalVolumes']} volumes, {manifest['totalPages']} pages"
        )

        series = manifest["series"]
        self.series_table.setRowCount(len(series))
        for row_index, series_entry in enumerate(series):
            self.series_table.setItem(row_index, 0, QTableWidgetItem(series_entry["title"]))
            self.series_table.setItem(row_index, 1, QTableWidgetItem(str(series_entry["volumeCount"])))
            self.series_table.setItem(row_index, 2, QTableWidgetItem(str(series_entry["pageCount"])))

        self.series_table.resizeColumnsToContents()

    def _append_log(self, message: str) -> None:
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.log_output.appendPlainText(f"[{timestamp}] {message}")
        self.tray_icon.setToolTip(message[:120] or "chimera host")

    def _restart_host(self) -> None:
        self._append_log("Restarting host service...")
        self.service.restart()

    def _open_local_panel(self) -> None:
        url = self.service.local_control_url
        if url is None:
            QMessageBox.warning(self, "Local panel unavailable", "The local control panel is not enabled.")
            return

        webbrowser.open(url)

    def _quit_from_ui(self) -> None:
        self.tray_icon.hide()
        self.service.stop()
        QApplication.instance().quit()

    @staticmethod
    def _format_timestamp(value: str | None) -> str:
        if not value:
            return "Never"

        try:
            return datetime.fromisoformat(value).astimezone().strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            return value


def main() -> None:
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    if not QSystemTrayIcon.isSystemTrayAvailable():
        QMessageBox.critical(None, "System tray unavailable", "A system tray is required to run the desktop host.")
        raise SystemExit(1)

    window = HostWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
