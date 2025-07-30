package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	firebase "firebase.google.com/go"
	"firebase.google.com/go/db"
	"github.com/creack/pty"
	"golang.org/x/term"
	"google.golang.org/api/option"
)

const (
	FirebaseConfigPath = "firebase_config.json"
	DBURL              = "https://python-hosting-server-default-rtdb.firebaseio.com/"
	SessionID          = "demo-session"
	BatchSize          = 128
)

type FirebaseSession struct {
	app        *firebase.App
	client     *db.Client
	InputRef   *db.Ref
	OutputRef  *db.Ref
	StateRef   *db.Ref
	ctx        context.Context
	cancelFunc context.CancelFunc
}

func NewFirebaseSession(status string) (*FirebaseSession, error) {
	ctx, cancel := context.WithCancel(context.Background())
	opt := option.WithCredentialsFile(FirebaseConfigPath)
	conf := &firebase.Config{DatabaseURL: DBURL}
	app, err := firebase.NewApp(ctx, conf, opt)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("error initializing app: %v", err)
	}
	client, err := app.Database(ctx)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("error initializing database: %v", err)
	}
	inputRef := client.NewRef(fmt.Sprintf("sessions/%s/input", SessionID))
	outputRef := client.NewRef(fmt.Sprintf("sessions/%s/output", SessionID))
	stateRef := client.NewRef(fmt.Sprintf("sessions/%s/state", SessionID))
	stateRef.Set(ctx, map[string]string{"status": status})
	return &FirebaseSession{
		app:        app,
		client:     client,
		InputRef:   inputRef,
		OutputRef:  outputRef,
		StateRef:   stateRef,
		ctx:        ctx,
		cancelFunc: cancel,
	}, nil
}

type FirebaseData struct {
	Data string `json:"data"`
}

func clientMode() {
	// Setup Firebase
	fb, err := NewFirebaseSession("client-connected")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer fb.cancelFunc()

	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to set terminal raw mode:", err)
		os.Exit(1)
	}
	defer term.Restore(int(os.Stdin.Fd()), oldState)

	// Signal handling to restore terminal
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-c
		term.Restore(int(os.Stdin.Fd()), oldState)
		os.Exit(1)
	}()

	readInput := func() {
		buf := make([]byte, BatchSize)
		for {
			n, err := os.Stdin.Read(buf)
			if err != nil {
				if err == io.EOF {
					break
				}
				continue
			}
			if n > 0 {
				data := string(buf[:n])
				fb.InputRef.Push(fb.ctx, map[string]string{"data": data})
			}
		}
	}

	writeOutput := func() {
		for {
			var outputData map[string]FirebaseData
			err := fb.OutputRef.Get(fb.ctx, &outputData)
			if err != nil && !strings.Contains(err.Error(), "no data available") {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			keys := make([]string, 0, len(outputData))
			for k := range outputData {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				chunk := outputData[k].Data
				os.Stdout.Write([]byte(chunk))
				fb.OutputRef.Child(k).Delete(fb.ctx)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	go readInput()
	writeOutput()
}

func serverMode() {
	// Setup Firebase
	fb, err := NewFirebaseSession("connected")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer fb.cancelFunc()

	// Start /bin/bash in a pty
	cmd := exec.Command("/bin/bash")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to start shell:", err)
		os.Exit(1)
	}
	defer ptmx.Close()

	readShell := func() {
		buf := make([]byte, BatchSize)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				data := string(buf[:n])
				fb.OutputRef.Push(fb.ctx, map[string]string{"data": data})
			}
			if err != nil {
				break
			}
		}
	}

	writeShell := func() {
		for {
			var inputData map[string]FirebaseData
			err := fb.InputRef.Get(fb.ctx, &inputData)
			if err != nil && !strings.Contains(err.Error(), "no data available") {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			keys := make([]string, 0, len(inputData))
			for k := range inputData {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				chunk := inputData[k].Data
				ptmx.Write([]byte(chunk))
				fb.InputRef.Child(k).Delete(fb.ctx)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	go readShell()
	writeShell()
}

func usage() {
	fmt.Println("Usage: <program> client|server")
}

func main() {
	if len(os.Args) < 2 {
		usage()
		return
	}
	switch os.Args[1] {
	case "client":
		clientMode()
	case "server":
		serverMode()
	default:
		usage()
	}
}
