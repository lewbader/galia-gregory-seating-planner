import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  User,
  doc,
  getFirebaseClient,
  onAuthStateChanged,
  onSnapshot,
  serverTimestamp,
  setDoc,
  signInWithPopup,
  signOut,
} from "./firebaseClient";

type Guest = {
  id: string;
  name: string;
  phone: string;
  tableId: string;
  notes?: string;
};

type Table = {
  id: string;
  name: string;
  capacity: number;
};

type SeatingPlan = {
  guests: Guest[];
  tables: Table[];
};

type SyncState = "local" | "signed-out" | "loading" | "synced" | "saving" | "error";
type ImportMode = "replace" | "add";

const initialGuests: Guest[] = [
  { id: "g-1", name: "Janet Wild", phone: "516-555-0101", tableId: "t-14" },
  { id: "g-2", name: "David Wild", phone: "516-555-0102", tableId: "t-14" },
  { id: "g-3", name: "Lori Schprechman", phone: "516-555-0103", tableId: "" },
  { id: "g-4", name: "Joel Schprechman", phone: "516-555-0104", tableId: "" },
  { id: "g-5", name: "Naomi Cohen", phone: "516-555-0105", tableId: "t-12" },
  { id: "g-6", name: "Michael Cohen", phone: "516-555-0106", tableId: "t-12" },
  { id: "g-7", name: "Rachel Stein", phone: "516-555-0107", tableId: "" },
  { id: "g-8", name: "Daniel Stein", phone: "516-555-0108", tableId: "" },
];

const initialTables: Table[] = [
  { id: "t-12", name: "Table 12", capacity: 10 },
  { id: "t-14", name: "Table 14", capacity: 10 },
  { id: "t-15", name: "Table 15", capacity: 12 },
  { id: "t-16", name: "Table 16", capacity: 12 },
];

const storageKey = "galia-gregory-seating-v1";

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanPhone(phone: string) {
  return phone.replace(/[^\d+]/g, "");
}

function csvEscape(value: string | number | undefined) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function tableSortValue(table: Table) {
  const number = table.name.match(/\d+/)?.[0];
  return number ? Number(number) : Number.MAX_SAFE_INTEGER;
}

function planFingerprint(guests: Guest[], tables: Table[]) {
  return JSON.stringify({ guests, tables });
}

export function SeatingApp() {
  const firebaseClient = useMemo(() => getFirebaseClient(), []);
  const [guests, setGuests] = useState<Guest[]>(initialGuests);
  const [tables, setTables] = useState<Table[]>(initialTables);
  const [user, setUser] = useState<User | null>(null);
  const [syncState, setSyncState] = useState<SyncState>(firebaseClient ? "signed-out" : "local");
  const [syncError, setSyncError] = useState("");
  const [guestQuery, setGuestQuery] = useState("");
  const [selectedGuestId, setSelectedGuestId] = useState(initialGuests[0]?.id ?? "");
  const [selectedTableId, setSelectedTableId] = useState(initialTables[1]?.id ?? "");
  const [newGuestName, setNewGuestName] = useState("");
  const [newGuestPhone, setNewGuestPhone] = useState("");
  const [newTableName, setNewTableName] = useState("");
  const [newTableCapacity, setNewTableCapacity] = useState(10);
  const [importMode, setImportMode] = useState<ImportMode>("replace");
  const [importNotice, setImportNotice] = useState("");
  const [copied, setCopied] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const remoteReadyRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const lastSyncedPlanRef = useRef("");

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as { guests?: Guest[]; tables?: Table[] };
      if (Array.isArray(parsed.guests)) setGuests(parsed.guests);
      if (Array.isArray(parsed.tables)) setTables(parsed.tables);
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify({ guests, tables }));
  }, [guests, tables]);

  useEffect(() => {
    if (!firebaseClient) {
      setSyncState("local");
      return undefined;
    }

    return onAuthStateChanged(firebaseClient.auth, (nextUser) => {
      setUser(nextUser);
      remoteReadyRef.current = false;
      setSyncError("");
      setSyncState(nextUser ? "loading" : "signed-out");
    });
  }, [firebaseClient]);

  useEffect(() => {
    if (!firebaseClient || !user) return undefined;

    const planRef = doc(firebaseClient.db, "seatingPlans", firebaseClient.planId);
    const unsubscribe = onSnapshot(
      planRef,
      (snapshot) => {
        const data = snapshot.data() as SeatingPlan | undefined;
        applyingRemoteRef.current = true;
        if (data?.guests && data?.tables) {
          lastSyncedPlanRef.current = planFingerprint(data.guests, data.tables);
          setGuests(data.guests);
          setTables(data.tables);
          setSelectedGuestId(data.guests[0]?.id ?? "");
          setSelectedTableId(data.tables[0]?.id ?? "");
        } else {
          setDoc(
            planRef,
            {
              guests,
              tables,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              updatedBy: user.email ?? user.uid,
            },
            { merge: true },
          ).catch((error: Error) => {
            setSyncState("error");
            setSyncError(error.message);
          });
        }
        remoteReadyRef.current = true;
        setSyncState("synced");
        window.setTimeout(() => {
          applyingRemoteRef.current = false;
        }, 0);
      },
      (error) => {
        setSyncState("error");
        setSyncError(error.message);
      },
    );

    return unsubscribe;
  }, [firebaseClient, user]);

  useEffect(() => {
    if (!firebaseClient || !user || !remoteReadyRef.current || applyingRemoteRef.current) return undefined;

    const nextFingerprint = planFingerprint(guests, tables);
    if (nextFingerprint === lastSyncedPlanRef.current) {
      setSyncState("synced");
      return undefined;
    }

    setSyncState("saving");
    const handle = window.setTimeout(() => {
      const planRef = doc(firebaseClient.db, "seatingPlans", firebaseClient.planId);
      setDoc(
        planRef,
        {
          guests,
          tables,
          updatedAt: serverTimestamp(),
          updatedBy: user.email ?? user.uid,
        },
        { merge: true },
      )
        .then(() => {
          lastSyncedPlanRef.current = nextFingerprint;
          setSyncState("synced");
        })
        .catch((error: Error) => {
          setSyncState("error");
          setSyncError(error.message);
        });
    }, 500);

    return () => window.clearTimeout(handle);
  }, [firebaseClient, guests, tables, user]);

  const tableCounts = useMemo(() => {
    return tables.reduce<Record<string, number>>((counts, table) => {
      counts[table.id] = guests.filter((guest) => guest.tableId === table.id).length;
      return counts;
    }, {});
  }, [guests, tables]);

  const tableById = useMemo(() => {
    return tables.reduce<Record<string, Table>>((map, table) => {
      map[table.id] = table;
      return map;
    }, {});
  }, [tables]);

  const selectedGuest = guests.find((guest) => guest.id === selectedGuestId) ?? guests[0];
  const selectedTable = tables.find((table) => table.id === selectedTableId) ?? tables[0];

  const assignedGuests = guests.filter((guest) => guest.tableId);
  const unassignedGuests = guests.filter((guest) => !guest.tableId);
  const overCapacityTables = tables.filter((table) => (tableCounts[table.id] ?? 0) > table.capacity);

  const filteredGuests = guests.filter((guest) => {
    const haystack = `${guest.name} ${guest.phone} ${tableById[guest.tableId]?.name ?? ""}`.toLowerCase();
    return haystack.includes(guestQuery.toLowerCase());
  });

  const sortedTables = [...tables].sort((a, b) => tableSortValue(a) - tableSortValue(b) || a.name.localeCompare(b.name));

  function assignGuest(guestId: string, tableId: string) {
    setGuests((current) =>
      current.map((guest) => (guest.id === guestId ? { ...guest, tableId } : guest)),
    );
    setSelectedGuestId(guestId);
    if (tableId) setSelectedTableId(tableId);
  }

  function addGuest() {
    if (!newGuestName.trim()) return;
    const guest = {
      id: makeId("g"),
      name: newGuestName.trim(),
      phone: newGuestPhone.trim(),
      tableId: selectedTableId || "",
    };
    setGuests((current) => [...current, guest]);
    setSelectedGuestId(guest.id);
    setNewGuestName("");
    setNewGuestPhone("");
  }

  function addTable() {
    if (!newTableName.trim()) return;
    const table = {
      id: makeId("t"),
      name: newTableName.trim(),
      capacity: Math.max(1, Number(newTableCapacity) || 1),
    };
    setTables((current) => [...current, table]);
    setSelectedTableId(table.id);
    setNewTableName("");
    setNewTableCapacity(10);
  }

  function updateTableCapacity(tableId: string, capacity: number) {
    setTables((current) =>
      current.map((table) =>
        table.id === tableId ? { ...table, capacity: Math.max(1, capacity || 1) } : table,
      ),
    );
  }

  function importGuests(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      const rows = parseCsv(text);
      const [header, ...body] = rows;
      const normalized = header.map((cell) => cell.toLowerCase().replace(/\s+/g, ""));
      const nameIndex = normalized.findIndex((cell) => ["name", "guest", "guestname"].includes(cell));
      const phoneIndex = normalized.findIndex((cell) => ["phone", "phonenumber", "mobile", "cell"].includes(cell));
      const tableIndex = normalized.findIndex((cell) => ["table", "tablename", "tablenumber"].includes(cell));

      if (nameIndex === -1) {
        setImportNotice("The CSV needs a Name column.");
        return;
      }

      const importedTableNames = Array.from(
        new Set(
          body
            .map((row) => (tableIndex >= 0 ? row[tableIndex]?.trim() : ""))
            .filter(Boolean),
        ),
      );

      const existingTableByName = tables.reduce<Record<string, Table>>((map, table) => {
        map[table.name.toLowerCase()] = table;
        return map;
      }, {});

      const importedTables = importedTableNames.map((tableName) => {
        return {
          id: existingTableByName[tableName.toLowerCase()]?.id ?? makeId("t"),
          name: tableName,
          capacity: existingTableByName[tableName.toLowerCase()]?.capacity ?? 10,
        };
      });

      const nextTables =
        importMode === "add"
          ? [
              ...tables,
              ...importedTables.filter((table) => !existingTableByName[table.name.toLowerCase()]),
            ]
          : importedTables;

      const nextGuests = body
        .filter((row) => row[nameIndex])
        .map((row) => {
          const tableName = tableIndex >= 0 ? row[tableIndex]?.trim() : "";
          const matchingTable = nextTables.find((table) => table.name.toLowerCase() === tableName.toLowerCase());
          return {
            id: makeId("g"),
            name: row[nameIndex],
            phone: phoneIndex >= 0 ? row[phoneIndex] : "",
            tableId: matchingTable?.id ?? "",
          };
        });

      if (importMode === "add") {
        setGuests((current) => [...current, ...nextGuests]);
      } else {
        setGuests(nextGuests);
      }
      if (nextTables.length || importMode === "replace") {
        setTables(nextTables);
        setSelectedTableId(nextTables[0]?.id ?? "");
      }
      setSelectedGuestId(nextGuests[0]?.id ?? "");
      setImportNotice(
        `${importMode === "add" ? "Added" : "Imported"} ${nextGuests.length} guests${
          importedTables.length ? ` and ${importMode === "add" ? "checked" : "created"} ${importedTables.length} tables` : ""
        }. Use CSV columns: Name, Table, Phone.`,
      );
    });
    event.target.value = "";
  }

  function exportGuests() {
    const lines = [
      ["Name", "Phone", "Table"].map(csvEscape).join(","),
      ...guests.map((guest) =>
        [guest.name, guest.phone, tableById[guest.tableId]?.name ?? ""].map(csvEscape).join(","),
      ),
    ];
    downloadFile("galia-gregory-guests.csv", lines.join("\n"));
  }

  function exportTables() {
    const lines = [
      ["Table", "Capacity", "Assigned", "Remaining"].map(csvEscape).join(","),
      ...sortedTables.map((table) =>
        [
          table.name,
          table.capacity,
          tableCounts[table.id] ?? 0,
          table.capacity - (tableCounts[table.id] ?? 0),
        ]
          .map(csvEscape)
          .join(","),
      ),
    ];
    downloadFile("galia-gregory-tables.csv", lines.join("\n"));
  }

  function downloadFile(filename: string, text: string) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function messageFor(guest: Guest) {
    const table = tableById[guest.tableId];
    const tableName = table?.name.replace(/^Table\s*/i, "") ?? "";
    return `We are so excited to celebrate with you tonight. Your table is ${tableName ? `Table ${tableName}` : "not yet assigned"}. Love, Galia & Gregory`;
  }

  async function copyAllMessages() {
    const text = assignedGuests
      .map((guest) => `${guest.name} (${guest.phone || "no phone"}): ${messageFor(guest)}`)
      .join("\n\n");
    await navigator.clipboard.writeText(text);
    setCopied("Copied all prepared texts.");
    window.setTimeout(() => setCopied(""), 2200);
  }

  async function connectFirebase() {
    if (!firebaseClient) return;
    setSyncState("loading");
    setSyncError("");
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ login_hint: "lewbader@gmail.com" });
      await signInWithPopup(firebaseClient.auth, provider);
    } catch (error) {
      setSyncState("error");
      setSyncError(error instanceof Error ? error.message : "Could not sign in to Firebase.");
    }
  }

  async function disconnectFirebase() {
    if (!firebaseClient) return;
    await signOut(firebaseClient.auth);
  }

  const tableGuests = selectedTable
    ? guests.filter((guest) => guest.tableId === selectedTable.id)
    : [];

  const openSeats = selectedTable ? selectedTable.capacity - (tableCounts[selectedTable.id] ?? 0) : 0;

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Galia & Gregory</p>
          <h1>Seating Planner</h1>
        </div>
        <div className="top-actions">
          <div className={`sync-pill ${syncState}`}>
            <span>{syncLabel(syncState, Boolean(firebaseClient), user)}</span>
            {syncError ? <small>{syncError}</small> : null}
          </div>
          {firebaseClient && !user ? (
            <button type="button" onClick={connectFirebase}>
              Sign in
            </button>
          ) : null}
          {firebaseClient && user ? (
            <button type="button" className="secondary" onClick={disconnectFirebase}>
              Sign out
            </button>
          ) : null}
          <select
            className="import-mode"
            value={importMode}
            aria-label="CSV import mode"
            onChange={(event) => setImportMode(event.target.value as ImportMode)}
          >
            <option value="replace">CSV replaces guests</option>
            <option value="add">CSV adds guests</option>
          </select>
          <button type="button" className="secondary" onClick={() => fileInputRef.current?.click()}>
            Import CSV
          </button>
          <button type="button" className="secondary" onClick={exportGuests}>
            Export Guests
          </button>
          <button type="button" className="secondary" onClick={exportTables}>
            Export Tables
          </button>
          <input ref={fileInputRef} className="hidden-input" type="file" accept=".csv,text/csv" onChange={importGuests} />
        </div>
      </section>

      <section className="stats-grid" aria-label="Seating status">
        <StatusCard label="Guests" value={guests.length} detail={`${assignedGuests.length} assigned`} />
        <StatusCard label="Unassigned" value={unassignedGuests.length} detail="Need a table" tone={unassignedGuests.length ? "warn" : "ok"} />
        <StatusCard label="Tables" value={tables.length} detail={`${overCapacityTables.length} over capacity`} tone={overCapacityTables.length ? "bad" : "ok"} />
        <StatusCard label="Seats Open" value={tables.reduce((sum, table) => sum + Math.max(0, table.capacity - (tableCounts[table.id] ?? 0)), 0)} detail="Across all tables" />
      </section>

      {importNotice ? <p className="notice">{importNotice}</p> : null}

      <section className="workspace">
        <section className="panel guest-panel">
          <div className="panel-heading">
            <div>
              <h2>Guests</h2>
              <p>Select a guest and assign a table.</p>
            </div>
            <input
              className="search"
              value={guestQuery}
              onChange={(event) => setGuestQuery(event.target.value)}
              placeholder="Search guests"
              aria-label="Search guests"
            />
          </div>

          <div className="guest-add">
            <input value={newGuestName} onChange={(event) => setNewGuestName(event.target.value)} placeholder="Guest name" aria-label="Guest name" />
            <input value={newGuestPhone} onChange={(event) => setNewGuestPhone(event.target.value)} placeholder="Phone" aria-label="Guest phone" />
            <button type="button" onClick={addGuest}>Add</button>
          </div>

          <div className="guest-list">
            {filteredGuests.map((guest) => {
              const table = tableById[guest.tableId];
              return (
                <button
                  type="button"
                  key={guest.id}
                  className={`guest-row ${guest.id === selectedGuestId ? "selected" : ""}`}
                  onClick={() => setSelectedGuestId(guest.id)}
                >
                  <span>
                    <strong>{guest.name}</strong>
                    <small>{guest.phone || "No phone"}</small>
                  </span>
                  <em>{table?.name ?? "Unassigned"}</em>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel assign-panel">
          <div className="panel-heading">
            <div>
              <h2>Assign</h2>
              <p>Move from either guest or table view.</p>
            </div>
          </div>

          {selectedGuest ? (
            <div className="assign-card">
              <p className="eyebrow">Selected Guest</p>
              <h3>{selectedGuest.name}</h3>
              <label>
                Table
                <select value={selectedGuest.tableId} onChange={(event) => assignGuest(selectedGuest.id, event.target.value)}>
                  <option value="">Unassigned</option>
                  {sortedTables.map((table) => {
                    const count = tableCounts[table.id] ?? 0;
                    return (
                      <option key={table.id} value={table.id}>
                        {table.name} ({count}/{table.capacity})
                      </option>
                    );
                  })}
                </select>
              </label>
              <button type="button" className="ghost" onClick={() => assignGuest(selectedGuest.id, "")}>
                Clear assignment
              </button>
            </div>
          ) : null}

          {selectedTable ? (
            <div className="assign-card">
              <p className="eyebrow">Selected Table</p>
              <h3>{selectedTable.name}</h3>
              <p className={openSeats < 0 ? "capacity bad-text" : "capacity"}>
                {tableCounts[selectedTable.id] ?? 0} of {selectedTable.capacity} seats used
              </p>
              <label>
                Add guest to this table
                <select value="" onChange={(event) => event.target.value && assignGuest(event.target.value, selectedTable.id)}>
                  <option value="">Choose an unassigned guest</option>
                  {unassignedGuests.map((guest) => (
                    <option key={guest.id} value={guest.id}>{guest.name}</option>
                  ))}
                </select>
              </label>
              <div className="mini-list">
                {tableGuests.map((guest) => (
                  <button type="button" key={guest.id} onClick={() => setSelectedGuestId(guest.id)}>
                    {guest.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="panel table-panel">
          <div className="panel-heading">
            <div>
              <h2>Tables</h2>
              <p>Capacity and seating counts.</p>
            </div>
          </div>

          <div className="table-add">
            <input value={newTableName} onChange={(event) => setNewTableName(event.target.value)} placeholder="Table name" aria-label="Table name" />
            <input
              type="number"
              min="1"
              value={newTableCapacity}
              onChange={(event) => setNewTableCapacity(Number(event.target.value))}
              aria-label="Table capacity"
            />
            <button type="button" onClick={addTable}>Add</button>
          </div>

          <div className="table-list">
            {sortedTables.map((table) => {
              const count = tableCounts[table.id] ?? 0;
              const remaining = table.capacity - count;
              return (
                <button
                  type="button"
                  key={table.id}
                  className={`table-row ${table.id === selectedTableId ? "selected" : ""} ${remaining < 0 ? "over" : ""}`}
                  onClick={() => setSelectedTableId(table.id)}
                >
                  <span>
                    <strong>{table.name}</strong>
                    <small>{remaining >= 0 ? `${remaining} seats open` : `${Math.abs(remaining)} over capacity`}</small>
                  </span>
                  <label onClick={(event) => event.stopPropagation()}>
                    Capacity
                    <input
                      type="number"
                      min="1"
                      value={table.capacity}
                      onChange={(event) => updateTableCapacity(table.id, Number(event.target.value))}
                    />
                  </label>
                </button>
              );
            })}
          </div>
        </section>
      </section>

      <section className="panel texting-panel">
        <div className="panel-heading">
          <div>
            <h2>Texting center</h2>
            <p>Review prepared messages before sending seatings.</p>
          </div>
          <div className="text-actions">
            <button type="button" className="secondary" onClick={copyAllMessages} disabled={!assignedGuests.length}>
              Copy All Texts
            </button>
          </div>
        </div>
        {copied ? <p className="notice compact">{copied}</p> : null}
        <div className="message-grid">
          {assignedGuests.map((guest) => {
            const phone = cleanPhone(guest.phone);
            const body = messageFor(guest);
            const href = phone ? `sms:${phone}?&body=${encodeURIComponent(body)}` : "";
            return (
              <article key={guest.id} className="message-card">
                <div>
                  <strong>{guest.name}</strong>
                  <small>{guest.phone || "No phone number"}</small>
                </div>
                <p>{body}</p>
                {href ? <a href={href}>Open Text</a> : <button type="button" disabled>Missing phone</button>}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function syncLabel(state: SyncState, hasFirebase: boolean, user: User | null) {
  if (!hasFirebase) return "Local only";
  if (!user) return "Firebase ready";
  if (state === "loading") return "Loading cloud plan";
  if (state === "saving") return "Saving";
  if (state === "synced") return `Synced as ${user.email ?? "Google user"}`;
  if (state === "error") return "Sync needs attention";
  return "Cloud sync";
}

function StatusCard({ label, value, detail, tone }: { label: string; value: number; detail: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <article className={`stat-card ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
