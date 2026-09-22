# Database recovery procedure

The API creates a verified, compressed full-database backup every 24 hours. Run `npm run backup` from the `backend` directory whenever an immediate recovery point is needed. Backup files are stored in `backend/backups` unless `BACKUP_DIR` is configured.

## Restore after data loss or corruption

1. Stop the API so no orders, stock changes, or task actions arrive during recovery.
2. Copy the selected `.json.gz` backup to a safe local path and keep the original untouched.
3. From `backend`, run:

   ```powershell
   npm run restore -- "C:\path\to\asawer-backup.json.gz" --confirm-restore
   ```

   The restore tool creates a fresh safety backup first, then restores all collections in one database transaction. A failed restore is rolled back.
4. Restart the API and verify the latest orders, inventory quantities, workflow tasks, and boss audit trail.
5. Record the incident, the restored backup filename, and any work entered after that backup that must be replayed.

## Production requirements

- Set `BACKUP_DIR` to persistent storage that survives a server replacement. Also copy backups to storage outside the application host.
- Protect access to backup files because they contain customer and operational data.
- Test a restore into a separate test database at least monthly.
- Default recovery point objective: 24 hours. Create more frequent backups by setting `BACKUP_INTERVAL_HOURS` to a smaller value.
