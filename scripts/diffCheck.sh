#!/bin/sh

RED='\033[0;91m'
NC='\033[0m' # No Color

REPO_NAME=$(basename `git rev-parse --show-toplevel`)

if [ "$REPO_NAME" == "perp-lushan" ]; then
    DIFF=$(git diff main public/main)
    if [ "$DIFF" != "" ]; then
      echo "${RED}!!!Error: perp-lushan has difference with public/main, please sync them first${NC}"
    fi

elif [ "$REPO_NAME" == "perp-curie-contract" ]; then
    DIFF=$(git diff main internal/main)
    if [ "$DIFF" != "" ]; then
      echo "${RED}!!!Error: perp-curie-contract has difference with internal/main, please sync them first${NC}"
    fi

fi