{
	"targets": [{
		"target_name": "sqlite_native",
		"sources": ["sqlite3.c", "qjs-sqlite.c"],
		"include_dirs": ["."],
		"defines": ["SQLITE_OMIT_LOAD_EXTENSION"]
	}]
}
