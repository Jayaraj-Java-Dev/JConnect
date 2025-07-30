package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"sort"
	"sync"
	"syscall"
	"time"

	firebase "firebase.google.com/go"
	"firebase.google.com/go/db"
	"github.com/creack/pty"
	"golang.org/x/term"
	"google.golang.org/api/option"
)

// CONFIG
const (
	FIREBASE_CONFIG_PATH = "firebase_config.json"
	DB_URL               = "https://python-hosting-server-default-rtdb.firebaseio.com/"
	SESSION_ID           = "demo-session"
)

func main() {
	mode := flag.String("mode", "", "Mode to run: client or server")
	flag.Parse()

	if *mode != "client" && *mode != "server" {
		fmt.Fprintf(os.Stderr, "Usage: %s -mode=client|server\n", os.Args[0])
		os.Exit(1)
	}

	ctx := context.Background()
	app, err := firebase.NewApp(ctx, &firebase.Config{DatabaseURL: DB_URL}, option.WithCredentialsFile(FIREBASE_CONFIG_PATH))
	if err != nil {
		panic(err)
	}
	client, err := app.Database(ctx)
	if err != nil {
		panic(err)
	}

	inputRef := client.NewRef(fmt.Sprintf("sessions/%s/input", SESSION_ID))
	outputRef := client.NewRef(fmt.Sprintf("sessions/%s/output", SESSION_ID))
	stateRef := client.NewRef(fmt.Sprintf("sessions/%s/state", SESSION_ID))

	if *mode == "client" {
		runClient(ctx, inputRef, outputRef, stateRef)
	} else {
		runServer(ctx, inputRef, outputRef, stateRef)
	}
}

func runClient(ctx context.Context, inputRef, outputRef, stateRef *db.Ref) {
	stateRef.Set(ctx, map[string]string{"status": "client-connected"})

	fd := int(os.Stdin.Fd())
	oldState, err := term.MakeRaw(fd)
	if err != nil {
		panic(err)
	}
	defer term.Restore(fd, oldState)

	var wg sync.WaitGroup

	// To restore terminal on Ctrl+C
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-c
		term.Restore(fd, oldState)
		os.Exit(0)
	}()

	wg.Add(2)

	// Read input from terminal and push to Firebase
	go func() {
		defer wg.Done()
		buf := make([]byte, 1)
		for {
			n, err := os.Stdin.Read(buf)
			if err != nil || n == 0 {
				break
			}
			val := map[string]interface{}{"b": int(buf[0])}
			_, err = inputRef.Push(ctx, val)
			if err != nil {
				break
			}
		}
	}()

	// Write output from Firebase to terminal
	go func() {
		defer wg.Done()
		for {
			var outputData map[string]map[string]interface{}
			err := outputRef.Get(ctx, &outputData)
			if err != nil && err.Error() != "cannot unmarshal bool into Go value of type map[string]map[string]interface {}" {
				time.Sleep(50 * time.Millisecond)
				continue
			}
			var keys []string
			for k := range outputData {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if bRaw, ok := outputData[k]["b"]; ok {
					b := byte(bRaw.(float64))
					os.Stdout.Write([]byte{b})
					outputRef.Child(k).Delete(ctx)
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
	}()

	wg.Wait()
}

func runServer(ctx context.Context, inputRef, outputRef, stateRef *db.Ref) {
	stateRef.Set(ctx, map[string]string{"status": "connected"})

	// Start bash in a PTY
	cmd := exec.Command("/bin/bash")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		panic(err)
	}
	defer func() { _ = ptmx.Close() }()

	var wg sync.WaitGroup
	wg.Add(2)

	// Read from shell and push to Firebase
	go func() {
		defer wg.Done()
		buf := make([]byte, 1024)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				break
			}
			for i := 0; i < n; i++ {
				val := map[string]interface{}{"b": int(buf[i])}
				_, err := outputRef.Push(ctx, val)
				if err != nil {
					break
				}
			}
		}
	}()

	// Write from Firebase to shell
	go func() {
		defer wg.Done()
		for {
			var inputData map[string]map[string]interface{}
			err := inputRef.Get(ctx, &inputData)
			if err != nil && err.Error() != "cannot unmarshal bool into Go value of type map[string]map[string]interface {}" {
				time.Sleep(50 * time.Millisecond)
				continue
			}
			var keys []string
			for k := range inputData {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if bRaw, ok := inputData[k]["b"]; ok {
					b := byte(bRaw.(float64))
					ptmx.Write([]byte{b})
					inputRef.Child(k).Delete(ctx)
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
	}()

	wg.Wait()
}
