// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IMarketRegistryStorageV1 {
    function clearingHouse() external view returns (address);

    function maxOrdersPerMarket() external view returns (uint8);
}

interface IMarketRegistryStorage is IMarketRegistryStorageV1 {}
