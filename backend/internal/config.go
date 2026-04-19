package internal

import (
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	Port         int
	DatabasePath string
}

func LoadConfig() Config {
	port := 8000
	if rawPort := os.Getenv("PORT"); rawPort != "" {
		if parsedPort, err := strconv.Atoi(rawPort); err == nil && parsedPort > 0 {
			port = parsedPort
		}
	}

	databasePath := os.Getenv("DATABASE_PATH")
	if databasePath == "" {
		databasePath = filepath.Join(".", "data", "app.db")
	}

	return Config{
		Port:         port,
		DatabasePath: databasePath,
	}
}

func (c Config) Addr() string {
	return ":" + strconv.Itoa(c.Port)
}
