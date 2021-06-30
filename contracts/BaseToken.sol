pragma solidity 0.7.6;

import "@openzeppelin/contracts/presets/ERC20PresetMinterPauser.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IPriceFeed } from "./interface/IPriceFeed.sol";

// TODO: Ownable
// TODO: only keep what we need in ERC20PresetMinterPauser
contract BaseToken is ERC20PresetMinterPauser {
    using SafeMath for uint256;
    IPriceFeed private immutable _priceFeed;
    uint8 private immutable _priceFeedDecimals;

    constructor(
        string memory name,
        string memory symbol,
        IPriceFeed priceFeed
    ) ERC20PresetMinterPauser(name, symbol) {
        // BT_IA: invalid address
        require(address(priceFeed) != address(0), "BT_IA");

        _priceFeed = priceFeed;
        _priceFeedDecimals = priceFeed.decimals();
    }

    // TODO: onlyOwner
    function setMinter(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }

    function getIndexPrice() external view returns (uint256) {
        return _formatDecimals(_priceFeed.getPrice());
    }

    function getIndexTwapPrice(uint256 _interval) external view returns (uint256) {
        return _formatDecimals(_priceFeed.getTwapPrice(_interval));
    }

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**uint256(decimals())).div(10**uint256(_priceFeedDecimals));
    }
}
