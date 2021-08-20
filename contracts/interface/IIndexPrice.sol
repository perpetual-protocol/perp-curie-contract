// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IIndexPrice {
    function getIndexPrice(uint256 interval) external view returns (uint256);
}
