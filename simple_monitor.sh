#!/bin/bash

function get_cpu_stat() {
    grep '^cpu' /proc/stat | awk '{print $1, $2, $3, $4, $5, $6, $7, $8, $9, $10}'
}

function calc_usage() {
    local line1="$1"
    local line2="$2"

    local vals1=($line1)
    local vals2=($line2)

    local id1=${vals1[4]}
    local id2=${vals2[4]}
    local total1=0
    local total2=0

    for i in "${vals1[@]:1}"; do total1=$((total1 + i)); done
    for i in "${vals2[@]:1}"; do total2=$((total2 + i)); done

    local diff_idle=$((id2 - id1))
    local diff_total=$((total2 - total1))

    if [ "$diff_total" -eq 0 ]; then
        echo "0"
    else
        echo $(( (1000 * (diff_total - diff_idle) / diff_total + 5) / 10 ))
    fi
}

function get_all_cpu_usage() {
    local before=()
    local after=()
    mapfile -t before < <(get_cpu_stat)
    sleep 0.5
    mapfile -t after < <(get_cpu_stat)

    for i in "${!before[@]}"; do
        usage=$(calc_usage "${before[$i]}" "${after[$i]}")
        tput setaf 2
        printf "%-5s: %3s %%\n" "$(echo "${before[$i]}" | awk '{print $1}')" "$usage"
        tput sgr0
    done
}

function get_battery_info() {
    BAT_PATH=$(upower -e | grep BAT)
    INFO=$(upower -i "$BAT_PATH")
    PERCENT=$(echo "$INFO" | grep -E "percentage" | awk '{print $2}')
    TIME_LEFT=$(echo "$INFO" | grep "time to empty" | awk -F ':' '{print $2 ":" $3}' | sed 's/^[ \t]*//')
    if [ -z "$TIME_LEFT" ]; then
        TIME_LEFT="Charging or N/A"
    fi
    tput setaf 3
    echo "Battery     : $PERCENT"
    echo "Time Left   : $TIME_LEFT"
    tput sgr0
}

# Main Loop
while true; do
    clear
    tput setaf 6; echo "===== Simple System Monitor ====="; tput sgr0
    get_all_cpu_usage
    echo ""
    get_battery_info
    sleep 1
done
