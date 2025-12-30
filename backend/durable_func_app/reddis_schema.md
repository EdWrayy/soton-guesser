
## Redis Data 
All keys use the prefix `match:{matchId}:` and have a **TTL of 2 hours** to ensure automatic cleanup of finished games.

| Data Category | Key Pattern | Type | Description |
| :--- | :--- | :--- | :--- |
| **Metadata** | `match:{id}:meta` | **Hash** | Static game settings (total rounds, owner, start time). |
| **Participants** | `match:{id}:players` | **Set** | Unique list of Player IDs currently connected to the match. |
| **Round Answer** | `match:{id}:ans` | **String** | The coordinates/solution for the *current* active round. |
| **Active Guesses**| `match:{id}:round_guesses` | **Hash** | **Field:** `playerId`, **Value:** JSON guess data. Cleared after every round. |
| **Leaderboard** | `match:{id}:scores` | **ZSet** | Persistent match rankings. **Score:** Total Points, **Member:** `playerId`. |