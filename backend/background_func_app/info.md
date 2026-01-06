### Scoring:
- Max Score: 5,000 points.
- Penalty: -1 point per km distant from target.
- Minimum: 0 points.

### Redis Interaction:
| Action | Type | Key |
| :--- | :--- | :--- |
| **Read Answer** | `GET` | `match:{game_id}:ans` |
| **Save Guess** | `HSET` | `match:{game_id}:round_guesses` |