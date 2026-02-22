/*
 * node:sqlite - Node.js compatible SQLite module
 *
 * Implements a subset of the Node.js node:sqlite API.
 * https://nodejs.org/api/sqlite.html
 */

import { sqlite_db } from './sqlite_native.so';

export class DatabaseSync {
    #db;
    #isOpen = false;
    #path;

    constructor(path, options = {}) {
        this.#path = path;
        const shouldOpen = options.open !== false;

        if (shouldOpen) {
            this.open();
        }
    }

    open() {
        if (this.#isOpen) {
            throw new Error('Database is already open');
        }
        this.#db = new sqlite_db(this.#path);
        this.#isOpen = true;
    }

    close() {
        if (!this.#isOpen) {
            throw new Error('Database is not open');
        }
        this.#db.close();
        this.#isOpen = false;
    }

    exec(sql) {
        if (!this.#isOpen) {
            throw new Error('Database is not open');
        }
        this.#db.exec(sql);
    }

    prepare(sql) {
        if (!this.#isOpen) {
            throw new Error('Database is not open');
        }
        const stmt = this.#db.prepare(sql);
        return new StatementSync(stmt, this.#db);
    }

    get isOpen() {
        return this.#isOpen;
    }
}

export class StatementSync {
    #stmt;
    #db;
    #columnNames = null;
    #readBigInts = false;

    constructor(stmt, db) {
        this.#stmt = stmt;
        this.#db = db;
    }

    setReadBigInts(enabled) {
        this.#readBigInts = !!enabled;
    }

    #bindParams(params) {
        for (let i = 0; i < params.length; i++) {
            this.#stmt.bind(i + 1, params[i]);
        }
    }

    #getColumnNames() {
        if (this.#columnNames === null) {
            const count = this.#stmt.column_count();
            this.#columnNames = [];
            for (let i = 0; i < count; i++) {
                this.#columnNames.push(this.#stmt.column_name(i));
            }
        }
        return this.#columnNames;
    }

    #readRow() {
        const names = this.#getColumnNames();
        const row = {};
        for (let i = 0; i < names.length; i++) {
            let value = this.#stmt.column_value(i);
            // Convert ArrayBuffer to Uint8Array for BLOB columns (Node.js compatibility)
            if (value instanceof ArrayBuffer) {
                value = new Uint8Array(value);
            } else if (this.#readBigInts && typeof value === 'number' && Number.isInteger(value)) {
                value = BigInt(value);
            }
            row[names[i]] = value;
        }
        return row;
    }

    run(...params) {
        this.#stmt.reset();
        this.#bindParams(params);
        this.#stmt.step();

        return {
            changes: this.#db.changes(),
            lastInsertRowid: this.#db.last_insert_rowid()
        };
    }

    get(...params) {
        this.#stmt.reset();
        this.#bindParams(params);

        const result = this.#stmt.step();
        if (result === 'row') {
            return this.#readRow();
        }
        return undefined;
    }

    all(...params) {
        this.#stmt.reset();
        this.#bindParams(params);

        const rows = [];
        while (this.#stmt.step() === 'row') {
            rows.push(this.#readRow());
        }
        return rows;
    }

    get sourceSQL() {
        return this.#stmt.sourceSQL;
    }
}
