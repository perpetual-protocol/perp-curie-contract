// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IOrderBookCallback {
    function addLiquidityFromTakerCallback(
        address trader,
        address baseToken,
        bool isBase,
        uint256 amount
    ) external returns (uint256 debt);
}
