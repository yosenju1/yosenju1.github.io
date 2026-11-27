#!/bin/bash
cd "$(dirname "$0")"
for i in 1 2 3 4 5 6; do t0=$(( (i-1)*10 )); t1=$(( t0+10 )); node render.js frames/s$i 0.667 $t0 $t1 24 > log_s$i.txt 2>&1; done
echo ALLDONE > done.txt
