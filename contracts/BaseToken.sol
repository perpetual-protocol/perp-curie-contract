// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IPriceFeed } from "./interface/IPriceFeed.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { VirtualToken } from "./VirtualToken.sol";

contract BaseToken is IIndexPrice, VirtualToken {
    using SafeMath for uint256;

    address public priceFeed;
    uint8 private immutable _priceFeedDecimals;

    constructor(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) public VirtualToken(nameArg, symbolArg) {
        // invalid address
        require(priceFeedArg != address(0), "BT_IA");

        // invalid price feed decimals
        require(IPriceFeed(priceFeedArg).decimals() <= decimals(), "BT_IPFD");
        priceFeed = priceFeedArg;
        _priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
    }

    /// @inheritdoc IIndexPrice
    function getIndexPrice(uint256 interval) external view override returns (uint256) {
        return _formatDecimals(IPriceFeed(priceFeed).getPrice(interval));
    }

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**uint256(decimals())).div(10**uint256(_priceFeedDecimals));
    }
}
