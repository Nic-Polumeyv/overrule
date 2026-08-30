# overrule

## 0.7.5

### Patch Changes

- [`7930b97`](https://github.com/Nic-Polumeyv/overrule/commit/7930b978ea9e5c5db7e553c24103f1929d7e2c22) Thanks [@Nic-Polumeyv](https://github.com/Nic-Polumeyv)! - perf: the CLI's token collection and cross maps drop SipHash for FxHash

## 0.7.4

### Patch Changes

- [`ae4da5a`](https://github.com/Nic-Polumeyv/overrule/commit/ae4da5ab1768c3d05c5a5b34b70e3a050a5fe6a7) Thanks [@Nic-Polumeyv](https://github.com/Nic-Polumeyv)! - new overrule-linux-arm64-musl platform package: Alpine on ARM gets a prebuilt binary

## 0.7.3

### Patch Changes

- [`06a507a`](https://github.com/Nic-Polumeyv/overrule/commit/06a507a3fef90908c3e8f93b8c04e3dd60bbd30f) Thanks [@Nic-Polumeyv](https://github.com/Nic-Polumeyv)! - linux-gnu binaries now run on glibc 2.17 and newer. 0.7.2 inherited the build runner's glibc and refused to start on anything older than Ubuntu 24.04.

- [`06a507a`](https://github.com/Nic-Polumeyv/overrule/commit/06a507a3fef90908c3e8f93b8c04e3dd60bbd30f) Thanks [@Nic-Polumeyv](https://github.com/Nic-Polumeyv)! - perf: hot paths stop hashing and cloning what they already hold
