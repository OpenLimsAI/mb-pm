"""Shared membership rules for the real, system-owned unfiled folder."""


def inbox_folder(catalogue):
    folders = catalogue.get("folders", [])
    return next(
        (folder for folder in folders if folder.get("systemRole") == "inbox"),
        next(
            (
                folder
                for folder in folders
                if folder.get("name") == "待整理" and not folder.get("parentId")
            ),
            None,
        ),
    )


def inbox_id(catalogue):
    folder = inbox_folder(catalogue)
    return folder["id"] if folder else None


def normalized_folder_ids(values, catalogue):
    """Treat unassigned papers as inbox and any other membership as organized."""
    known = {folder["id"] for folder in catalogue.get("folders", [])}
    selected = set(values or []) & known
    inbox = inbox_id(catalogue)
    if not inbox:
        return sorted(selected)
    organized = selected - {inbox}
    return sorted(organized) if organized else [inbox]
