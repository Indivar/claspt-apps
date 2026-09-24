# A vault made by Claspt 3.0.6

This directory is test data: a vault written by the code of release 3.0.6,
the last version published before 4.1. `src/vault/old_vault_tests.rs` opens a
copy of it with the current code, to prove that someone upgrading from 3.0.6
still gets into their vault.

It was produced by checking out the `v3.0.6` tag and calling that version's
own `vault::init::initialize_vault`, `pages::secret::encrypt_secrets`,
`pages::secret::encrypt_full_body` and `pages::crud::create_page`. Nothing in
it was written by hand or by a later version, which is the point: do not
regenerate it with current code.

| | |
|---|---|
| Master password | `made-by-claspt-3.0.6` |
| `credentials/…-bank-login.md` | one `:::secret` block holding `hunter2-from-3.0.6` |
| `general/…-private-journal.md` | a page encrypted whole |
| `RECOVERY-KEY.txt` | the recovery key 3.0.6 handed out for this vault |

The vault has never held anything real. The help pages and the git history
3.0.6 also created are left out; neither is read when a vault is opened.
