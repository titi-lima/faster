// Profile only the Vitest main process: forked workers inherit process.execArgv, and the CPU profiler
// conflicts with the coverage inspector session inside workers.
process.execArgv = process.execArgv.filter(argument => !argument.startsWith('--cpu-prof'))
