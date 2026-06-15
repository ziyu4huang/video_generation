#!/bin/bash
playwright-cli -s=mytest open http://localhost:3099/#/cmd/video-compare --browser=webkit &
PID=$!
sleep 3
playwright-cli -s=mytest screenshot --filename=/tmp/gui-ux/video-compare-before.png
wait $PID
