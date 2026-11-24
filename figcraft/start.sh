#!/bin/zsh
# Open the Sonderline brand kit in FigCraft as a normal document (no control port: it won't take focus).
# Rebuild headless with: python3 figcraft/build_kit.py [--fresh] [--stage ...]
open -a FigCraft "${0:A:h}/sonderline-brand-kit.figcraft"
