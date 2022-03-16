// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { VirtualToken } from "./VirtualToken.sol";
import { BaseTokenStorageV1 } from "./storage/BaseTokenStorage.sol";
import { IBaseToken } from "./interface/IBaseToken.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract BaseToken is IBaseToken, IIndexPrice, VirtualToken, BaseTokenStorageV1 {
    using SafeMathUpgradeable for uint256;
    using SafeMathUpgradeable for uint8;

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) external initializer {
        __VirtualToken_init(nameArg, symbolArg);

        uint8 priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();

        // invalid price feed decimals
        require(priceFeedDecimals <= decimals(), "BT_IPFD");

        _priceFeed = priceFeedArg;
        _priceFeedDecimals = priceFeedDecimals;
    }

    /// @dev This function is only used for emergency shutdown, to set priceFeed to an emergencyPriceFeed
    function setPriceFeed(address priceFeedArg) external onlyOwner {
        // ChainlinkPriceFeed uses 8 decimals
        // BandPriceFeed uses 18 decimals
        uint8 priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
        // BT_IPFD: Invalid price feed decimals
        require(priceFeedDecimals <= decimals(), "BT_IPFD");

        _priceFeed = priceFeedArg;
        _priceFeedDecimals = priceFeedDecimals;

        emit PriceFeedChanged(_priceFeed);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IIndexPrice
    function getIndexPrice(uint256 interval) external view override returns (uint256) {
        return _formatDecimals(IPriceFeed(_priceFeed).getPrice(interval));
    }

    /// @inheritdoc IBaseToken
    function getPriceFeed() external view override returns (address) {
        return _priceFeed;
    }

    //
    // INTERNAL VIEW
    //

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**(decimals().sub(_priceFeedDecimals)));
    }
}
