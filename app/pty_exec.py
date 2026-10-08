"""Establish the controlling terminal in a fresh subprocess before execing tmux."""
import fcntl
import os
import sys
import termios

fcntl.ioctl(0, termios.TIOCSCTTY, 0)
os.execv(sys.argv[1], [sys.argv[1], '-S', sys.argv[2], 'attach-session', '-t', sys.argv[3]])
