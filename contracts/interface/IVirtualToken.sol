// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IVirtualToken {
    function isInWhitelist(address account) external view returns (bool);
}
