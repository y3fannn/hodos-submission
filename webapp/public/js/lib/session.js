// Which state the app is in, and the few actions any screen may ask for. main.js owns the state and
// fills in the actions; screens call them without importing main.js.
//   setup  - first run: profile, then the lock, then the recovery key
//   locked - a vault exists and is closed
//   open   - unlocked; the store is open and every write is sealed
//   demo   - sample data, not locked, said so on every screen
export const session = {
  mode: "boot",
  lockNow: async () => {},
  startDemo: async () => {},
  endDemo: async () => {},
  wipe: async () => {},
  showRecovery: () => {},
  render: () => {},
};
