// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IBaseTokenStorageV1 {
    function priceFeed() external view returns (address);
}
