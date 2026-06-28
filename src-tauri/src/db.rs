//! Local persistence layer. Plain functions over a rusqlite `Connection` so they
//! can be unit-tested against an in-memory database; the Tauri command layer wraps
//! these with the managed `Mutex<Connection>`.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Milestone {
    pub id: String,
    pub title: String,
    pub done: bool,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub title: String,
    pub priority: String,
    pub position: i64,
    pub milestones: Vec<Milestone>,
}

/// A milestone as supplied by the edit dialog. An existing milestone carries its
/// `id` (kept, renamed, reordered — its `done` flag is preserved from the DB); a
/// new milestone has `id: None` and starts not-done.
#[derive(Debug, Clone, Deserialize)]
pub struct MilestoneInput {
    pub id: Option<String>,
    pub title: String,
}

fn now_ts() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Create the schema if it does not yet exist. Idempotent.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS projects (
             id         TEXT PRIMARY KEY,
             title      TEXT NOT NULL,
             priority   TEXT NOT NULL,
             position   INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS milestones (
             id         TEXT PRIMARY KEY,
             project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
             title      TEXT NOT NULL,
             done       INTEGER NOT NULL,
             position   INTEGER NOT NULL
         );",
    )
}

/// All projects ordered by `position`, each with its milestones ordered by `position`.
pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<Project>> {
    let mut stmt =
        conn.prepare("SELECT id, title, priority, position FROM projects ORDER BY position ASC")?;
    let mut projects: Vec<Project> = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                title: row.get(1)?,
                priority: row.get(2)?,
                position: row.get(3)?,
                milestones: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut ms = conn.prepare(
        "SELECT id, title, done, position FROM milestones WHERE project_id = ?1 ORDER BY position ASC",
    )?;
    for p in projects.iter_mut() {
        p.milestones = ms
            .query_map(params![p.id], |row| {
                Ok(Milestone {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    done: row.get::<_, i64>(2)? != 0,
                    position: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(projects)
}

/// Insert a project (appended to the end) with the given milestone titles, all
/// initially not-done. Returns the created project including generated ids.
pub fn create_project(
    conn: &Connection,
    title: &str,
    priority: &str,
    milestone_titles: &[String],
) -> rusqlite::Result<Project> {
    let id = uuid::Uuid::new_v4().to_string();
    let position: i64 =
        conn.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM projects", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO projects (id, title, priority, position, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, title, priority, position, now_ts()],
    )?;

    let mut milestones = Vec::with_capacity(milestone_titles.len());
    for (i, mt) in milestone_titles.iter().enumerate() {
        let mid = uuid::Uuid::new_v4().to_string();
        let pos = i as i64;
        conn.execute(
            "INSERT INTO milestones (id, project_id, title, done, position) VALUES (?1, ?2, ?3, 0, ?4)",
            params![mid, id, mt, pos],
        )?;
        milestones.push(Milestone { id: mid, title: mt.clone(), done: false, position: pos });
    }

    Ok(Project {
        id,
        title: title.to_string(),
        priority: priority.to_string(),
        position,
        milestones,
    })
}

/// Set a single milestone's done flag.
pub fn set_milestone_done(conn: &Connection, milestone_id: &str, done: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE milestones SET done = ?1 WHERE id = ?2",
        params![done as i64, milestone_id],
    )?;
    Ok(())
}

/// Update a project's title/priority and reconcile its milestones against the
/// desired list (by position): existing ids are renamed/reordered with their
/// `done` preserved, missing ids are deleted, and id-less entries are inserted
/// not-done. Returns the updated project.
pub fn update_project(
    conn: &Connection,
    id: &str,
    title: &str,
    priority: &str,
    milestones: &[MilestoneInput],
) -> rusqlite::Result<Project> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE projects SET title = ?1, priority = ?2, updated_at = ?3 WHERE id = ?4",
        params![title, priority, now_ts(), id],
    )?;

    let existing: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM milestones WHERE project_id = ?1")?;
        let rows = stmt.query_map(params![id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let keep: std::collections::HashSet<&str> =
        milestones.iter().filter_map(|m| m.id.as_deref()).collect();
    for ex in existing.iter() {
        if !keep.contains(ex.as_str()) {
            tx.execute("DELETE FROM milestones WHERE id = ?1", params![ex])?;
        }
    }

    for (i, m) in milestones.iter().enumerate() {
        let pos = i as i64;
        match m.id.as_deref() {
            Some(mid) if existing.iter().any(|e| e == mid) => {
                tx.execute(
                    "UPDATE milestones SET title = ?1, position = ?2 WHERE id = ?3",
                    params![m.title, pos, mid],
                )?;
            }
            _ => {
                let nid = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO milestones (id, project_id, title, done, position) VALUES (?1, ?2, ?3, 0, ?4)",
                    params![nid, id, m.title, pos],
                )?;
            }
        }
    }

    tx.commit()?;

    list_projects(conn)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Delete a project and its milestones.
pub fn delete_project(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM milestones WHERE project_id = ?1", params![id])?;
    tx.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_schema(&c).unwrap();
        c
    }

    #[test]
    fn empty_db_lists_no_projects() {
        let c = mem();
        assert_eq!(list_projects(&c).unwrap().len(), 0);
    }

    #[test]
    fn created_project_round_trips_with_milestones_in_order() {
        let c = mem();
        let titles = vec!["立项".to_string(), "数据层".to_string(), "联调".to_string()];
        let created = create_project(&c, "测试项目", "high", &titles).unwrap();

        let all = list_projects(&c).unwrap();
        assert_eq!(all.len(), 1);
        let got = &all[0];
        assert_eq!(got.id, created.id);
        assert_eq!(got.title, "测试项目");
        assert_eq!(got.priority, "high");
        assert_eq!(got.milestones.len(), 3);
        assert_eq!(got.milestones[0].title, "立项");
        assert_eq!(got.milestones[2].title, "联调");
        assert!(got.milestones.iter().all(|m| !m.done));
    }

    #[test]
    fn set_milestone_done_persists_per_milestone() {
        let c = mem();
        let p = create_project(&c, "P", "normal", &["a".into(), "b".into()]).unwrap();
        let first = p.milestones[0].id.clone();

        set_milestone_done(&c, &first, true).unwrap();
        let got = &list_projects(&c).unwrap()[0];
        assert!(got.milestones[0].done);
        assert!(!got.milestones[1].done);

        set_milestone_done(&c, &first, false).unwrap();
        assert!(!list_projects(&c).unwrap()[0].milestones[0].done);
    }

    #[test]
    fn projects_returned_in_insertion_order() {
        let c = mem();
        create_project(&c, "first", "normal", &[]).unwrap();
        create_project(&c, "second", "normal", &[]).unwrap();
        let all = list_projects(&c).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].title, "first");
        assert_eq!(all[1].title, "second");
    }

    #[test]
    fn update_project_reconciles_milestones_and_preserves_done() {
        let c = mem();
        let p = create_project(&c, "P", "normal", &["a".into(), "b".into(), "c".into()]).unwrap();
        let b_id = p.milestones[1].id.clone();
        set_milestone_done(&c, &b_id, true).unwrap();

        // rename project + bump priority; keep a (renamed) + b, drop c, append new d
        let desired = vec![
            MilestoneInput { id: Some(p.milestones[0].id.clone()), title: "a2".into() },
            MilestoneInput { id: Some(b_id.clone()), title: "b".into() },
            MilestoneInput { id: None, title: "d".into() },
        ];
        let updated = update_project(&c, &p.id, "P2", "high", &desired).unwrap();
        assert_eq!(updated.title, "P2");
        assert_eq!(updated.priority, "high");

        let got = &list_projects(&c).unwrap()[0];
        assert_eq!(got.title, "P2");
        assert_eq!(got.priority, "high");
        assert_eq!(got.milestones.len(), 3);
        assert_eq!(got.milestones[0].title, "a2");
        assert_eq!(got.milestones[1].title, "b");
        assert_eq!(got.milestones[2].title, "d");
        assert!(got.milestones[1].done); // b's done preserved
        assert!(!got.milestones[0].done);
        assert!(!got.milestones[2].done);
        assert_eq!(got.milestones[0].position, 0);
        assert_eq!(got.milestones[2].position, 2);
    }

    #[test]
    fn delete_project_removes_project_and_its_milestones() {
        let c = mem();
        let keep = create_project(&c, "keep", "normal", &["x".into()]).unwrap();
        let gone = create_project(&c, "gone", "normal", &["y".into(), "z".into()]).unwrap();

        delete_project(&c, &gone.id).unwrap();

        let all = list_projects(&c).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, keep.id);
        assert_eq!(all[0].milestones.len(), 1);

        let orphan: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM milestones WHERE project_id = ?1",
                params![gone.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 0);
    }
}
